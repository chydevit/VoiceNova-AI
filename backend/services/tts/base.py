from pathlib import Path


class TTSProvider:
    """One Khmer text-to-speech engine. To add a provider, subclass this and register it in tts/__init__.py."""

    name = ""
    label = ""
    genders: tuple[str, ...] = ("male", "female")

    def status(self) -> tuple[bool, str]:
        """(ready, reason it isn't)."""
        return True, ""

    def synthesize(self, text: str, gender: str, speed: float, out: Path, attempt: int = 0) -> Path:
        """Write the spoken `text` to `out` (any audio format ffmpeg can read). Return the written path.
        `attempt` counts the tries after a clip came out wrong; an engine that can, says it differently."""
        raise NotImplementedError
