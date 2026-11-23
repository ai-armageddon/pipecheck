"""Local CLI sessions used by the owner of a single-user PipeCheck instance."""
import asyncio
import json
import os
import shutil
import signal
import tempfile
from pathlib import Path
from typing import Literal

Provider = Literal["off", "groq", "claude", "codex"]
CLI_LOGIN = {"claude": "claude auth login", "codex": "codex login"}
CLIProvider = Literal["claude", "codex"]


class ProviderError(Exception):
    pass


async def run_cli(args, cwd, prompt=None, timeout=90, discard_output=False):
    output = asyncio.subprocess.DEVNULL if discard_output else asyncio.subprocess.PIPE
    try:
        process = await asyncio.create_subprocess_exec(
            *args, cwd=cwd, start_new_session=True,
            stdin=asyncio.subprocess.PIPE, stdout=output, stderr=output,
        )
    except OSError as exc:
        raise ProviderError(f"Could not start {args[0]}. Check the backend PATH.") from exc
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(prompt.encode() if prompt is not None else b""), timeout
        )
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await process.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise ProviderError(f"{args[0]} did not respond within {timeout} seconds.") from exc
    return process.returncode, (stdout or b"").decode(errors="replace"), (stderr or b"").decode(errors="replace")


async def login_cli(provider: CLIProvider):
    args = ["claude", "auth", "login", "--claudeai"] if provider == "claude" else ["codex", "login"]
    try:
        with tempfile.TemporaryDirectory(prefix="pipecheck-login-") as directory:
            code, _, _ = await run_cli(args, directory, timeout=300, discard_output=True)
        return "finished" if code == 0 else "failed"
    except ProviderError:
        return "failed"


async def cli_status(provider):
    if not shutil.which(provider):
        return "not_installed"
    args = ["claude", "auth", "status", "--json"] if provider == "claude" else ["codex", "login", "status"]
    try:
        with tempfile.TemporaryDirectory() as directory:
            code, output, diagnostic = await run_cli(args, directory, timeout=8)
        if provider == "claude":
            status = json.loads(output)
            if status.get("loggedIn"):
                return "subscription" if status.get("authMethod") == "claude.ai" else "authenticated"
        elif code == 0:
            return "subscription" if "chatgpt" in (output + diagnostic).lower() else "authenticated"
        return "signed_out"
    except (ValueError, ProviderError):
        return "unavailable"


async def cli_completion(provider, prompt, system):
    with tempfile.TemporaryDirectory(prefix="pipecheck-repair-") as directory:
        if provider == "claude":
            args = ["claude", "-p", "--tools", "", "--strict-mcp-config", "--mcp-config",
                    '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence",
                    "--setting-sources", "", "--system-prompt", system, "--output-format", "text"]
        else:
            result = Path(directory) / "response.txt"
            args = ["codex", "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                    "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'web_search="disabled"',
                    "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps",
                    "--disable", "plugins", "--disable", "computer_use", "--disable", "multi_agent",
                    "-o", str(result), "-"]
            prompt = f"{system}\n\n{prompt}"
        code, output, _ = await run_cli(args, directory, prompt)
        if code != 0:
            raise ProviderError(f"{provider} could not complete the repair. Check CLI sign-in and usage limits.")
        if provider == "codex":
            if not result.is_file():
                raise ProviderError("Codex returned no final response.")
            output = result.read_text()
        return output.strip()
