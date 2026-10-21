"""Meta MMS-TTS (facebook/mms-tts-khm): free, open-source and fully offline after the
first download. One voice only, and it sounds more robotic than the neural services.
Needs the extra packages: pip install -r requirements-extra.txt"""
import threading
from pathlib import Path

import config
from errors import AppError, LineError

from .base import TTSProvider


class MmsTTS(TTSProvider):
    name = "mms"
    label = "Meta MMS-TTS (offline)"
    genders = ("default",)

    def __init__(self):
        self._model = None
        self._tokenizer = None
        self._lock = threading.Lock()

    def status(self):
        try:
            import torch  # noqa: F401
            import transformers  # noqa: F401
            return True, ""
        except ImportError:
            return False, "torch and transformers are not installed (pip install -r requirements-extra.txt)"

    def _load(self):
        with self._lock:
            if self._model is None:
                ok, reason = self.status()
                if not ok:
                    raise AppError("The offline Khmer voice isn't installed.", hint=reason)
                from transformers import AutoTokenizer, VitsModel

                try:
                    self._tokenizer = AutoTokenizer.from_pretrained(config.MMS_MODEL)
                    self._model = VitsModel.from_pretrained(config.MMS_MODEL).eval()
                except Exception as err:  # noqa: BLE001 - usually the first download failing
                    raise AppError("Couldn't load the MMS Khmer voice model.", hint="The first run downloads it — check your internet connection.", detail=str(err)) from err
        return self._model, self._tokenizer

    def synthesize(self, text: str, gender: str, speed: float, out: Path, attempt: int = 0) -> Path:
        import torch

        from services import media

        model, tokenizer = self._load()
        inputs = tokenizer(text, return_tensors="pt")
        if inputs["input_ids"].shape[-1] == 0:
            raise LineError("The offline voice can't read this line.", detail=text[:80])
        with self._lock:  # one generation at a time; the model is not thread-safe
            model.speaking_rate = speed
            torch.manual_seed(attempt)  # same text → same delivery; another try → another delivery
            with torch.no_grad():
                waveform = model(**inputs).waveform[0].cpu().numpy()
        wav = out.with_suffix(".mms.wav")
        media.write_wav(wav, waveform, rate=model.config.sampling_rate)
        return wav
