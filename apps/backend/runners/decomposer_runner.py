#!/usr/bin/env python3
"""
PRD Decomposition Runner
=========================

Decomposes a PRD/spec into independent workstreams for parallel execution.
Reads spec.md from the spec directory and outputs decomposition.json.

The decomposer agent analyzes the PRD, investigates the project structure,
and defines 2-6 self-contained workstreams with dependency information.
Each workstream becomes its own Auto Claude task with a dedicated worktree.

Usage:
    python runners/decomposer_runner.py --spec-dir /path/to/spec --project-dir /path/to/project
    python runners/decomposer_runner.py --spec-dir /path/to/spec --model opus --thinking-level high
"""

import sys

# Python version check - must be before any imports using 3.10+ syntax
if sys.version_info < (3, 10):  # noqa: UP036
    sys.exit(
        f"Error: Auto Claude requires Python 3.10 or higher.\n"
        f"You are running Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}\n"
        f"\n"
        f"Please upgrade Python: https://www.python.org/downloads/"
    )

import asyncio
import io
import json
from pathlib import Path

# Configure safe encoding on Windows BEFORE any imports that might print
# This handles both TTY and piped output (e.g., from Electron)
if sys.platform == "win32":
    for _stream_name in ("stdout", "stderr"):
        _stream = getattr(sys, _stream_name)
        # Method 1: Try reconfigure (works for TTY)
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")
                continue
            except (AttributeError, io.UnsupportedOperation, OSError):
                pass
        # Method 2: Wrap with TextIOWrapper for piped output
        try:
            if hasattr(_stream, "buffer"):
                _new_stream = io.TextIOWrapper(
                    _stream.buffer,
                    encoding="utf-8",
                    errors="replace",
                    line_buffering=True,
                )
                setattr(sys, _stream_name, _new_stream)
        except (AttributeError, io.UnsupportedOperation, OSError):
            pass
    # Clean up temporary variables
    del _stream_name, _stream
    if "_new_stream" in dir():
        del _new_stream

# Add auto-claude to path (parent of runners/)
sys.path.insert(0, str(Path(__file__).parent.parent))

# Validate platform-specific dependencies BEFORE any imports that might
# trigger graphiti_core -> real_ladybug -> pywintypes import chain (ACS-253)
from core.dependency_validator import validate_platform_dependencies

validate_platform_dependencies()

# Load .env file with centralized error handling
from cli.utils import import_dotenv

load_dotenv = import_dotenv()

env_file = Path(__file__).parent.parent / ".env"
dev_env_file = Path(__file__).parent.parent.parent / "dev" / "auto-claude" / ".env"
if env_file.exists():
    load_dotenv(env_file)
elif dev_env_file.exists():
    load_dotenv(dev_env_file)

# Initialize Sentry early to capture any startup errors
from core.sentry import capture_exception, init_sentry

init_sentry(component="decomposer-runner")

from core.client import create_client
from debug import debug, debug_error, debug_section, debug_success
from phase_config import (
    get_thinking_budget,
    resolve_model_id,
    sanitize_thinking_level,
)


async def run_decomposition(
    spec_dir: Path,
    project_dir: Path,
    model: str,
    thinking_level: str,
) -> bool:
    """Run the decomposition agent to analyze the PRD and create workstreams.

    Args:
        spec_dir: Directory containing the spec.md to decompose
        project_dir: Root directory for the target project
        model: Resolved model ID to use
        thinking_level: Thinking level (low, medium, high)

    Returns:
        True if decomposition completed successfully and produced valid output
    """
    debug_section("decomposer", "PRD Decomposition")

    # Load the decomposer prompt
    prompt_path = Path(__file__).parent.parent / "prompts" / "decomposer.md"
    if not prompt_path.exists():
        debug_error("decomposer", f"Decomposer prompt not found: {prompt_path}")
        return False

    decomposer_prompt = prompt_path.read_text(encoding="utf-8")

    # Read spec.md for the PRD content
    spec_file = spec_dir / "spec.md"
    if not spec_file.exists():
        debug_error("decomposer", f"spec.md not found in: {spec_dir}")
        return False

    spec_content = spec_file.read_text(encoding="utf-8")

    # Build the user message with the decomposer instructions + PRD content.
    # The decomposer prompt is included in the user message (not system prompt)
    # because create_client() builds its own base system prompt internally.
    # This follows the same pattern as planner.py and other agent sessions.
    user_message = (
        f"{decomposer_prompt}\n\n"
        f"---\n\n"
        f"## Spec Directory\n{spec_dir}\n\n"
        f"## Project Directory\n{project_dir}\n\n"
        f"## PRD Content (from spec.md)\n\n{spec_content}\n\n"
        f"---\n\n"
        f"Please analyze the project structure, identify independent workstreams, "
        f"and write `decomposition.json` to the spec directory: "
        f"{spec_dir}/decomposition.json"
    )

    # Resolve thinking budget for the client
    max_thinking_tokens = get_thinking_budget(thinking_level)

    # Create the client with appropriate permissions
    # Uses the "decomposer" agent config: Read + Write + Edit + Bash + Glob + Grep
    client = create_client(
        project_dir=project_dir,
        spec_dir=spec_dir,
        model=model,
        agent_type="decomposer",
        max_thinking_tokens=max_thinking_tokens,
    )

    debug(
        "decomposer",
        "Starting decomposition agent",
        spec_dir=str(spec_dir),
        project_dir=str(project_dir),
        model=model,
        thinking_level=thinking_level,
        max_thinking_tokens=max_thinking_tokens,
    )

    try:
        async with client:
            await client.query(user_message)

            # Consume the response stream to let the agent run to completion
            async for msg in client.receive_response():
                msg_type = type(msg).__name__
                # Log assistant messages for debugging but don't need to process them
                if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                    for block in msg.content:
                        block_type = type(block).__name__
                        if block_type == "TextBlock" and hasattr(block, "text"):
                            debug(
                                "decomposer",
                                "Agent output",
                                text_length=len(block.text),
                            )

        debug("decomposer", "Agent session completed")

        # Verify decomposition.json was created
        decomposition_file = spec_dir / "decomposition.json"
        if not decomposition_file.exists():
            debug_error("decomposer", "Agent did not create decomposition.json")
            return False

        # Validate the output
        return _validate_decomposition(decomposition_file)

    except Exception as e:
        debug_error("decomposer", f"Decomposition agent failed: {e}")
        capture_exception(e, spec_dir=str(spec_dir))
        return False


def _validate_decomposition(decomposition_file: Path) -> bool:
    """Validate the decomposition.json output.

    Checks:
    - Valid JSON structure
    - Workstream count between 2 and 6
    - All dependency references are valid
    - No cycles in the dependency graph (valid DAG)
    - Required fields present on each workstream

    Args:
        decomposition_file: Path to the decomposition.json file

    Returns:
        True if the decomposition is valid
    """
    try:
        with open(decomposition_file, encoding="utf-8") as f:
            decomposition = json.load(f)
    except json.JSONDecodeError as e:
        debug_error("decomposer", f"Invalid JSON in decomposition.json: {e}")
        return False

    # Check top-level structure
    workstreams = decomposition.get("workstreams", [])
    if not workstreams:
        debug_error("decomposer", "decomposition.json has no workstreams")
        return False

    if len(workstreams) < 2:
        debug_error(
            "decomposer",
            f"Only {len(workstreams)} workstream(s) — need at least 2",
        )
        return False

    if len(workstreams) > 6:
        debug_error(
            "decomposer",
            f"{len(workstreams)} workstreams — maximum is 6",
        )
        return False

    # Validate required fields on each workstream
    required_fields = {"id", "title", "description", "depends_on", "estimated_files"}
    ids = set()
    for ws in workstreams:
        missing = required_fields - set(ws.keys())
        if missing:
            debug_error(
                "decomposer",
                f"Workstream {ws.get('id', '?')} missing required fields: {missing}",
            )
            return False
        ids.add(ws["id"])

    # Validate dependency references
    for ws in workstreams:
        for dep in ws.get("depends_on", []):
            if dep not in ids:
                debug_error(
                    "decomposer",
                    f"Workstream {ws['id']} depends on unknown workstream: {dep}",
                )
                return False

    # Cycle detection via topological sort (Kahn's algorithm)
    in_degree = {ws_id: 0 for ws_id in ids}
    graph = {ws_id: [] for ws_id in ids}
    for ws in workstreams:
        for dep in ws.get("depends_on", []):
            graph[dep].append(ws["id"])
            in_degree[ws["id"]] += 1

    queue = [ws_id for ws_id, deg in in_degree.items() if deg == 0]
    sorted_count = 0
    while queue:
        node = queue.pop(0)
        sorted_count += 1
        for neighbor in graph[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if sorted_count != len(ids):
        debug_error("decomposer", "Dependency cycle detected in workstreams")
        return False

    # Compute summary stats
    independent_count = sum(
        1 for ws in workstreams if not ws.get("depends_on")
    )

    debug_success(
        "decomposer",
        f"Decomposition valid: {len(workstreams)} workstreams",
        independent=independent_count,
        total=len(workstreams),
    )
    return True


def main():
    """CLI entry point."""
    import argparse

    debug_section("decomposer_runner", "Decomposer Runner CLI")

    parser = argparse.ArgumentParser(
        description="Decompose a PRD into independent workstreams for parallel execution",
    )
    parser.add_argument(
        "--spec-dir",
        type=Path,
        required=True,
        help="Spec directory containing spec.md",
    )
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=Path.cwd(),
        help="Project directory (default: current directory)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet",
        help="Model to use (haiku, sonnet, opus, or full model ID)",
    )
    parser.add_argument(
        "--thinking-level",
        type=str,
        default="medium",
        help="Thinking level (low, medium, high)",
    )

    args = parser.parse_args()

    # Validate and sanitize thinking level (handles legacy values like 'ultrathink')
    args.thinking_level = sanitize_thinking_level(args.thinking_level)

    resolved_model = resolve_model_id(args.model)

    debug(
        "decomposer_runner",
        "Arguments",
        spec_dir=str(args.spec_dir),
        project_dir=str(args.project_dir),
        model=resolved_model,
        thinking_level=args.thinking_level,
    )

    try:
        success = asyncio.run(
            run_decomposition(
                spec_dir=args.spec_dir,
                project_dir=args.project_dir,
                model=resolved_model,
                thinking_level=args.thinking_level,
            )
        )

        if not success:
            debug_error("decomposer_runner", "Decomposition failed")
            sys.exit(1)

        debug_success("decomposer_runner", "Decomposition succeeded")
        sys.exit(0)

    except KeyboardInterrupt:
        debug_error("decomposer_runner", "Decomposition interrupted")
        print("\n\nDecomposition interrupted.")
        sys.exit(1)
    except Exception as e:
        capture_exception(e, spec_dir=str(args.spec_dir))
        debug_error("decomposer_runner", f"Unexpected error: {e}")
        print(f"\n\nUnexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
