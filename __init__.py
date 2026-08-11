"""Hermes Agent registration for Istra's workflow skills."""

from pathlib import Path


_SKILLS = {
    "istra-project-memory": "Use Istra as durable operational project memory through its MCP tools.",
    "istra-error-reporting": "Report concrete or strongly suspected faults in Istra itself.",
}


def register(ctx) -> None:
    """Register the Hermes-specific Istra workflow skills."""

    skills_dir = Path(__file__).parent / "hermes" / "skills"
    for name, description in _SKILLS.items():
        ctx.register_skill(name, skills_dir / name / "SKILL.md", description)
