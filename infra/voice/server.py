"""Sara's voice: Silero v5_5_ru speaks the answers of the voice app (ADR-028).

Only the core calls it, inside the Docker network that has no way out. The model is in memory only while Boris talks:
a worker process loads it on the first request (or on /warm) and is stopped after IDLE_S seconds without one, so the
server's memory goes back to the others between talks. Requests go one at a time. When the server is short of memory
(less than MIN_FREE_MB available) the model is not loaded at all: the app then lets the phone say the answer.

    GET  /health           {"ok": true, "loaded": false}
    POST /warm             starts loading the model, answers at once (202)
    POST /speak            {"text": "...", "speaker": "xenia"} -> audio/wav (48 kHz mono)

The text comes from the core already made speakable (numbers as words, no links); anything outside the Cyrillic
letters and punctuation is dropped here once more, since the model refuses it.
"""
import io
import json
import multiprocessing as mp
import os
import re
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_PATH = os.environ.get("VOICE_MODEL", "/models/v5_5_ru.pt")
PORT = int(os.environ.get("VOICE_PORT", "7080"))
IDLE_S = float(os.environ.get("VOICE_IDLE_S", "300"))
# A loaded model takes about 0.9 GB (Lora's Silero on the same server, 07.11.2026): below this, the server would swap.
MIN_FREE_MB = int(os.environ.get("VOICE_MIN_FREE_MB", "800"))
LOAD_TIMEOUT_S = float(os.environ.get("VOICE_LOAD_TIMEOUT_S", "180"))
SPEAK_TIMEOUT_S = float(os.environ.get("VOICE_SPEAK_TIMEOUT_S", "120"))
THREADS = int(os.environ.get("VOICE_THREADS", "2"))
SPEAKERS = {"xenia", "baya", "kseniya", "aidar", "eugene"}
SAMPLE_RATE = 48000
MAX_TEXT = 2000
# The model takes a piece of limited length at a time.
MAX_CHUNK = 800
PAUSE_S = 0.25
NOT_SPEAKABLE = re.compile(r"[^А-Яа-яЁё0-9\s.,!?:;\-()«»\"'…+]")


def speakable(text: str) -> str:
    return " ".join(NOT_SPEAKABLE.sub(" ", text).split())


def chunks(text: str) -> list[str]:
    """Cuts the text by sentences, and a sentence too long for the model by spaces."""
    parts: list[str] = []
    current = ""
    for sentence in re.split(r"(?<=[.!?…])\s+", text):
        while len(sentence) > MAX_CHUNK:
            cut = sentence.rfind(" ", 0, MAX_CHUNK)
            cut = cut if cut > 0 else MAX_CHUNK
            if current:
                parts.append(current)
                current = ""
            parts.append(sentence[:cut])
            sentence = sentence[cut:].strip()
        if current and len(current) + 1 + len(sentence) > MAX_CHUNK:
            parts.append(current)
            current = ""
        current = f"{current} {sentence}".strip()
    if current:
        parts.append(current)
    return [p for p in parts if re.search(r"[А-Яа-яЁё]", p)]


def available_mb() -> int:
    """The host's available memory: /proc/meminfo in a container shows the whole server."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 1 << 20


def worker(conn, model_path: str, threads: int) -> None:
    """Holds the model; answers (speaker, text) with wav bytes or an error line."""
    try:
        import torch

        torch.set_num_threads(threads)
        model = torch.package.PackageImporter(model_path).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
        # The first synthesis after a load is slower than the next ones.
        model.apply_tts(text="Привет.", speaker="xenia", sample_rate=SAMPLE_RATE)
    except Exception as e:  # the parent hears why, instead of waiting
        conn.send(("error", f"модель не загрузилась: {e}"))
        return
    conn.send(("ready", None))
    while True:
        speaker, text = conn.recv()
        try:
            pause = torch.zeros(int(SAMPLE_RATE * PAUSE_S))
            pieces = []
            for chunk in chunks(text):
                pieces.append(model.apply_tts(text=chunk, speaker=speaker, sample_rate=SAMPLE_RATE))
                pieces.append(pause)
            if not pieces:
                raise ValueError("в тексте нечего произносить")
            audio = (torch.cat(pieces[:-1]).clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
            out = io.BytesIO()
            with wave.open(out, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)
                w.writeframes(audio)
            conn.send(("ok", out.getvalue()))
        except Exception as e:  # one bad text must not stop the worker
            conn.send(("error", str(e)))


def answer(conn, proc, timeout_s: float):
    """The worker's next message; never waits on a dead worker or past the time given."""
    until = time.monotonic() + timeout_s
    while time.monotonic() < until:
        if conn.poll(0.5):
            return conn.recv()
        if not proc.is_alive():
            raise RuntimeError("рабочий процесс озвучки упал")
    raise RuntimeError("озвучка не ответила вовремя")


class Voice:
    """The worker's life: started on demand, stopped after IDLE_S seconds without a request."""

    def __init__(self, target=worker, args=None, free_mb=available_mb, idle_s=None, tick_s=15.0) -> None:
        self.lock = threading.Lock()
        self.proc = None
        self.conn = None
        self.last = 0.0
        self.target = target
        self.args = args if args is not None else (MODEL_PATH, THREADS)
        self.free_mb = free_mb
        self.idle_s = IDLE_S if idle_s is None else idle_s
        self.tick_s = tick_s
        threading.Thread(target=self._reaper, daemon=True).start()

    def loaded(self) -> bool:
        return self.proc is not None and self.proc.is_alive()

    def _start(self) -> None:
        if self.loaded():
            return
        free = self.free_mb()
        if free < MIN_FREE_MB:
            raise RuntimeError(f"мало памяти на сервере: {free} МБ")
        ctx = mp.get_context("spawn")
        parent, child = ctx.Pipe()
        proc = ctx.Process(target=self.target, args=(child, *self.args), daemon=True)
        proc.start()
        # Only the worker holds its end now: if it dies, the parent's end sees it.
        child.close()
        try:
            kind, value = answer(parent, proc, LOAD_TIMEOUT_S)
            if kind != "ready":
                raise RuntimeError(value or "модель не загрузилась")
        except BaseException:
            proc.kill()
            proc.join(5)
            parent.close()
            raise
        self.proc, self.conn = proc, parent

    def _stop(self) -> None:
        if self.proc is not None:
            self.proc.kill()
            self.proc.join(5)
        if self.conn is not None:
            self.conn.close()
        self.proc, self.conn = None, None

    def warm(self) -> None:
        def go() -> None:
            with self.lock:
                self.last = time.monotonic()
                try:
                    self._start()
                except Exception as e:
                    print(f"voice: warm failed: {e}", flush=True)

        threading.Thread(target=go, daemon=True).start()

    def speak(self, speaker: str, text: str) -> bytes:
        with self.lock:
            self.last = time.monotonic()
            try:
                self._start()
                self.conn.send((speaker, text))
                kind, value = answer(self.conn, self.proc, SPEAK_TIMEOUT_S)
            except (EOFError, OSError, RuntimeError) as e:
                # Short of memory, or the worker died or hung: the next request starts a new one.
                print(f"voice: speak failed: {e}", flush=True)
                self._stop()
                raise RuntimeError(str(e)) from e
            finally:
                self.last = time.monotonic()
            if kind != "ok":
                raise ValueError(value)
            return value

    def _reaper(self) -> None:
        while True:
            time.sleep(self.tick_s)
            idle = time.monotonic() - self.last > self.idle_s
            if self.loaded() and idle and self.lock.acquire(blocking=False):
                try:
                    if time.monotonic() - self.last > self.idle_s:
                        self._stop()
                        print("voice: model unloaded after idle", flush=True)
                finally:
                    self.lock.release()


# Made in __main__ only: the spawned worker imports this module too and must not start a reaper of its own.
VOICE: "Voice | None" = None


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            return self._json(200, {"ok": True, "loaded": VOICE is not None and VOICE.loaded()})
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/warm":
            VOICE.warm()
            return self._json(202, {"ok": True})
        if self.path != "/speak":
            return self._json(404, {"error": "not found"})
        try:
            size = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(min(size, 64_000)) or b"{}")
            text = speakable(str(req.get("text") or ""))[:MAX_TEXT]
            speaker = str(req.get("speaker") or "xenia")
        except ValueError:
            return self._json(400, {"error": "bad request"})
        if speaker not in SPEAKERS or not re.search(r"[А-Яа-яЁё]", text):
            return self._json(400, {"error": "nothing to say"})
        try:
            wav = VOICE.speak(speaker, text)
        except ValueError as e:
            return self._json(422, {"error": str(e)})
        except RuntimeError as e:
            return self._json(503, {"error": str(e)})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, *args) -> None:  # the texts are Boris's conversation: never in the logs
        pass


if __name__ == "__main__":
    VOICE = Voice()
    print(f"voice: listening on {PORT}, model {MODEL_PATH}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
