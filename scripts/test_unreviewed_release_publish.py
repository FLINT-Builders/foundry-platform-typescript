#!/usr/bin/env python3
"""Security spec for npm publishing from the release workflow.

These tests fail while an unreviewed commit can be published. They pass once a
push of refs/heads/release/* or refs/tags/@osdk/{foundry,gotham,shared.net.platformapi}@*
no longer publishes a tree that is not the commit reachable from main.

The publish command under test is scripts/ci-publish.sh, which the release
workflow runs. pnpm itself is replaced with a recorder so the test never
contacts a registry.

scripts/ci:publishSnapshot is not covered: the release workflow does not call it.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"
PUBLISH_SCRIPT = ROOT / "scripts" / "ci-publish.sh"
MARKER = "release-publish-marker.txt"


class WorkflowLoader(yaml.SafeLoader):
    pass


# PyYAML 1.1 treats the workflow key "on" as a boolean. Drop that resolver
# for this loader only.
_src_resolvers = yaml.SafeLoader.yaml_implicit_resolvers
WorkflowLoader.yaml_implicit_resolvers = {
    key: [(tag, rx) for tag, rx in resolvers if tag != "tag:yaml.org,2002:bool"]
    for key, resolvers in _src_resolvers.items()
}


def load_workflow():
    return yaml.load(WORKFLOW.read_text(), Loader=WorkflowLoader)


def compile_filter(pattern: str) -> re.Pattern[str]:
    """Compile one GitHub Actions branch/tag filter pattern.

    Rules are the filter-pattern cheat sheet: '*' does not match '/', '**'
    matches across '/', and '?' / '+' quantify the preceding character or
    character class.
    """
    atoms: list[str] = []
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if char == "\\":
            if i + 1 >= len(pattern):
                raise ValueError(f"trailing escape in {pattern!r}")
            atoms.append(re.escape(pattern[i + 1]))
            i += 2
            continue
        if char == "*" and pattern.startswith("**", i):
            atoms.append(".*")
            i += 2
            continue
        if char == "*":
            atoms.append("[^/]*")
            i += 1
            continue
        if char == "[":
            end = pattern.find("]", i + 1)
            if end == -1:
                raise ValueError(f"unclosed character class in {pattern!r}")
            atoms.append(pattern[i : end + 1])
            i = end + 1
            continue
        if char in ("?", "+"):
            if not atoms:
                raise ValueError(f"{char} without a preceding atom in {pattern!r}")
            atom = atoms.pop()
            quant = "?" if char == "?" else "+"
            atoms.append(f"(?:{atom}){quant}")
            i += 1
            continue
        atoms.append(re.escape(char))
        i += 1
    return re.compile("^" + "".join(atoms) + "$")


def filter_matches(patterns: list[str] | None, name: str) -> bool:
    if not patterns:
        return False
    matched = False
    for pattern in patterns:
        if pattern.startswith("!"):
            if matched and compile_filter(pattern[1:]).fullmatch(name):
                matched = False
            continue
        if compile_filter(pattern).fullmatch(name):
            matched = True
    return matched


def ref_kind_and_name(ref: str) -> tuple[str, str]:
    if ref.startswith("refs/heads/"):
        return "branch", ref[len("refs/heads/") :]
    if ref.startswith("refs/tags/"):
        return "tag", ref[len("refs/tags/") :]
    raise ValueError(f"unsupported ref {ref}")


def _split_top(expr: str, operator: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    quote: str | None = None
    i = 0
    while i < len(expr):
        char = expr[i]
        if quote:
            buf.append(char)
            if char == quote and (not buf or expr[i - 1] != "\\"):
                quote = None
            i += 1
            continue
        if char in ("'", '"'):
            quote = char
            buf.append(char)
            i += 1
            continue
        if char == "(":
            depth += 1
            buf.append(char)
            i += 1
            continue
        if char == ")":
            depth -= 1
            buf.append(char)
            i += 1
            continue
        if depth == 0 and expr.startswith(operator, i):
            parts.append("".join(buf))
            buf = []
            i += len(operator)
            continue
        buf.append(char)
        i += 1
    parts.append("".join(buf))
    return parts


def _strip_expr(expr: str) -> str:
    text = expr.strip()
    if text.startswith("${{") and text.endswith("}}"):
        return text[3:-2].strip()
    return text


def _eval_atom(expr: str, ref: str) -> bool | None:
    text = expr.strip()
    if text in ("true", "false"):
        return text == "true"
    starts = re.fullmatch(r"startsWith\(\s*github\.ref\s*,\s*'([^']*)'\s*\)", text)
    if starts:
        return ref.startswith(starts.group(1))
    ends = re.fullmatch(r"endsWith\(\s*github\.ref\s*,\s*'([^']*)'\s*\)", text)
    if ends:
        return ref.endswith(ends.group(1))
    equals = re.fullmatch(r"github\.ref\s*==\s*'([^']*)'", text)
    if equals:
        return ref == equals.group(1)
    not_equals = re.fullmatch(r"github\.ref\s*!=\s*'([^']*)'", text)
    if not_equals:
        return ref != not_equals.group(1)
    if text.startswith("(") and text.endswith(")"):
        return eval_if(text[1:-1], ref)
    return None


def eval_if(expr: str, ref: str) -> bool:
    """Evaluate the release job's if expression. Unknown syntax fails open
    (the job is treated as running) so a rewritten condition cannot hide the
    publish script from these tests.
    """
    text = _strip_expr(expr)
    if not text:
        return True
    or_parts = _split_top(text, "||")
    if len(or_parts) > 1:
        return any(eval_if(part, ref) for part in or_parts)
    and_parts = _split_top(text, "&&")
    if len(and_parts) > 1:
        return all(eval_if(part, ref) for part in and_parts)
    negated = text.strip()
    if negated.startswith("!"):
        return not eval_if(negated[1:], ref)
    atom = _eval_atom(text, ref)
    if atom is None:
        return True
    return atom


def publish_job(workflow: dict) -> dict:
    for job in workflow["jobs"].values():
        for step in job.get("steps") or []:
            run = step.get("run") or ""
            if "ci:publish" in run:
                return job
    raise AssertionError("release workflow has no ci:publish step")


def push_triggers_publish_job(workflow: dict, ref: str) -> bool:
    kind, name = ref_kind_and_name(ref)
    push = workflow["on"]["push"]
    patterns = push.get("branches" if kind == "branch" else "tags")
    if not filter_matches(patterns, name):
        return False
    job = publish_job(workflow)
    condition = job.get("if")
    if condition is None:
        return True
    return eval_if(str(condition), ref)


class FilterPatternTests(unittest.TestCase):
    def test_cheat_sheet_examples(self):
        cases = {
            "feature/*": {
                "feature/my-branch": True,
                "feature/your-branch": True,
                "feature/beta-a/my-branch": False,
                "feature": False,
            },
            "feature/**": {
                "feature/beta-a/my-branch": True,
                "feature/your-branch": True,
                "feature/mona/the/octocat": True,
            },
            "main": {"main": True, "main2": False, "origin/main": False},
            "releases/mona-the-octocat": {
                "releases/mona-the-octocat": True,
                "releases/other": False,
            },
            "*": {"main": True, "releases": True, "all/the/branches": False},
            "**": {"all/the/branches": True, "every/tag": True},
            "*feature": {
                "mona-feature": True,
                "feature": True,
                "ver-10-feature": True,
                "feature/x": False,
            },
            "v2*": {"v2": True, "v2.0": True, "v2.9": True, "v3": False},
            "v[12].[0-9]+.[0-9]+": {
                "v1.10.1": True,
                "v2.0.0": True,
                "v3.0.0": False,
                "v1.a.0": False,
            },
            "Octo*": {"Octocat": True, "Octo/cat": False},
            "*.jsx?": {"page.js": True, "page.jsx": True, "page.jss": False},
            "[CB]at": {"Cat": True, "Bat": True, "Rat": False},
            "[1-2]00": {"100": True, "200": True, "300": False},
        }
        for pattern, expectations in cases.items():
            for name, expected in expectations.items():
                self.assertEqual(
                    filter_matches([pattern], name),
                    expected,
                    f"{pattern!r} against {name!r}",
                )


class UnreviewedReleasePublishTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = load_workflow()

    def test_documented_attack_refs_match_the_workflow_as_shipped(self):
        # Locks the matcher to the patterns in this repository. Removing the
        # patterns is a valid fix and is covered by the publish tests below;
        # this only fails if a pattern is present but would not select the ref.
        push = self.workflow["on"]["push"]
        if "release/*" in (push.get("branches") or []):
            self.assertTrue(filter_matches(push["branches"], "release/unreviewed"))
        for pattern, tag in (
            ("@osdk/foundry@*", "@osdk/foundry@9.9.9"),
            ("@osdk/gotham@*", "@osdk/gotham@9.9.9"),
            ("@osdk/shared.net.platformapi@*", "@osdk/shared.net.platformapi@9.9.9"),
        ):
            if pattern in (push.get("tags") or []):
                self.assertTrue(filter_matches(push["tags"], tag))

    def test_unreviewed_release_branch_is_not_published(self):
        self._assert_evil_not_published("refs/heads/release/unreviewed", mismatch_sha=False)

    def test_unreviewed_nested_release_branch_is_not_published(self):
        self._assert_evil_not_published("refs/heads/release/unreviewed/nested", mismatch_sha=False)

    def test_unreviewed_foundry_tag_is_not_published(self):
        self._assert_evil_not_published("refs/tags/@osdk/foundry@9.9.9", mismatch_sha=False)

    def test_unreviewed_gotham_tag_is_not_published(self):
        self._assert_evil_not_published("refs/tags/@osdk/gotham@9.9.9", mismatch_sha=False)

    def test_unreviewed_platformapi_tag_is_not_published(self):
        self._assert_evil_not_published(
            "refs/tags/@osdk/shared.net.platformapi@9.9.9",
            mismatch_sha=False,
        )

    def test_authorized_sha_does_not_publish_a_different_tree(self):
        # GITHUB_SHA names main while the checkout is the unreviewed commit.
        # Authorizing one commit and publishing the other must not publish
        # the unreviewed tree.
        self._assert_evil_not_published("refs/tags/@osdk/foundry@9.9.9", mismatch_sha=True)

    def test_next_ref_does_not_publish_unreviewed_tree(self):
        self._assert_evil_not_published("refs/heads/next", mismatch_sha=False)

    def test_main_still_publishes_the_main_tree(self):
        with self._repo() as repo:
            self._run(repo, "refs/heads/main", repo["main"], expect_publish=True)

    def test_tag_of_a_main_commit_still_publishes_that_commit(self):
        with self._repo() as repo:
            self._run(
                repo,
                "refs/tags/@osdk/foundry@1.2.3",
                repo["main"],
                expect_publish=True,
            )

    def _assert_evil_not_published(self, ref: str, mismatch_sha: bool):
        with self._repo() as repo:
            before = self._snapshot(repo["root"])
            github_sha = repo["main"] if mismatch_sha else repo["evil"]
            subprocess.run(
                ["git", "checkout", "--force", repo["evil"]],
                cwd=repo["root"],
                check=True,
                capture_output=True,
                text=True,
            )
            triggered = push_triggers_publish_job(self.workflow, ref)
            log = ""
            if triggered:
                _result, log = self._execute(repo["root"], ref, github_sha)
            self.assertNotIn(repo["evil"], log)
            self.assertNotIn("evil", log)
            if not log.strip():
                self.assertEqual(
                    before,
                    self._snapshot(repo["root"]),
                    "publish refused only after changing the tree",
                )

    def _run(self, repo, ref: str, sha: str, expect_publish: bool):
        self.assertTrue(
            push_triggers_publish_job(self.workflow, ref),
            f"{ref} no longer schedules the publish job",
        )
        subprocess.run(
            ["git", "checkout", "--force", sha],
            cwd=repo["root"],
            check=True,
            capture_output=True,
            text=True,
        )
        result, log = self._execute(repo["root"], ref, sha)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        if expect_publish:
            self.assertIn(sha, log)
            self.assertIn("safe", log)
            self.assertNotIn("evil", log)

    def _execute(self, cwd: Path, ref: str, sha: str):
        log_path = cwd / "publish-log.txt"
        stub = cwd / "bin" / "pnpm"
        env = os.environ.copy()
        env["PATH"] = str(cwd / "bin") + os.pathsep + env["PATH"]
        env["GITHUB_REF"] = ref
        env["GITHUB_SHA"] = sha
        env["PUBLISH_LOG"] = str(log_path)
        env.pop("NODE_AUTH_TOKEN", None)
        env.pop("NPM_TOKEN", None)
        result = subprocess.run(
            ["bash", str(PUBLISH_SCRIPT)],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
        )
        log = log_path.read_text() if log_path.exists() else ""
        return result, log

    def _repo(self):
        return _Repo()

    def _snapshot(self, root: Path) -> dict[str, bytes]:
        files: dict[str, bytes] = {}
        for path in root.rglob("*"):
            if ".git" in path.parts or path.parent.name == "bin":
                continue
            if path.is_file() and path.name != "publish-log.txt":
                files[str(path.relative_to(root))] = path.read_bytes()
        return files


class _Repo:
    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True, capture_output=True)
        self._git("config", "user.email", "release-test@example.com")
        self._git("config", "user.name", "release-test")
        (root / MARKER).write_text("safe\n")
        self._git("add", MARKER)
        self._git("commit", "-m", "reviewed")
        main = self._git("rev-parse", "HEAD").stdout.strip()
        self._git("checkout", "-b", "release/unreviewed")
        (root / MARKER).write_text("evil\n")
        self._git("add", MARKER)
        self._git("commit", "-m", "unreviewed")
        evil = self._git("rev-parse", "HEAD").stdout.strip()
        self._git("update-ref", "refs/remotes/origin/main", main)
        self._git("checkout", "--force", evil)
        stub_dir = root / "bin"
        stub_dir.mkdir()
        stub = stub_dir / "pnpm"
        stub.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                set -euo pipefail
                if [[ "${1:-}" == "publish" || " $* " == *" publish "* ]]; then
                  {
                    printf 'head %s\\n' "$(git rev-parse HEAD)"
                    printf 'marker %s\\n' "$(cat release-publish-marker.txt)"
                  } >> "$PUBLISH_LOG"
                fi
                exit 0
                """
            )
        )
        stub.chmod(0o755)
        self.data = {"root": root, "main": main, "evil": evil}

    def _git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=self._tmp.name,
            check=True,
            capture_output=True,
            text=True,
        )

    def __enter__(self):
        return self.data

    def __exit__(self, exc_type, exc, tb):
        self._tmp.cleanup()
        return False


if __name__ == "__main__":
    unittest.main()
