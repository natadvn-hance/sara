"""The voice service's worker life without the model (ADR-028): a load that fails, a worker that dies or hangs, the
memory guard and the unload after silence must never leave the service waiting forever.

    python3 -I -m unittest discover -s infra/voice -p 'test_*.py'
"""
import http.client
import os
import shutil
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

os.environ.setdefault("VOICE_LOAD_TIMEOUT_S", "5")
os.environ.setdefault("VOICE_SPEAK_TIMEOUT_S", "3")

import server  # noqa: E402


def echo_worker(conn, *_):
    conn.send(("ready", None))
    while True:
        speaker, text = conn.recv()
        conn.send(("ok", f"{speaker}:{text}".encode()))


def failing_load(conn, *_):
    conn.send(("error", "модель не загрузилась: Permission denied"))


def dies_on_load(conn, *_):
    os._exit(1)


def dies_on_speak(conn, *_):
    conn.send(("ready", None))
    conn.recv()
    os._exit(1)


def hangs_on_speak(conn, *_):
    conn.send(("ready", None))
    conn.recv()
    time.sleep(60)


def recording_worker(conn, log):
    """Echoes, and writes every (speaker, text) it was asked to a file, so a test sees the warm-up phrases."""
    conn.send(("ready", None))
    while True:
        speaker, text = conn.recv()
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{speaker}\t{text}\n")
        conn.send(("ok", f"{speaker}:{text}".encode()))


def dies_on_first_warm_up(conn, flag):
    """Dies on the first warm-up phrase it hears (once for all workers: the flag is a file), then echoes."""
    conn.send(("ready", None))
    while True:
        speaker, text = conn.recv()
        if text == server.WARM_TEXT and not os.path.exists(flag):
            open(flag, "w").close()
            os._exit(1)
        conn.send(("ok", f"{speaker}:{text}".encode()))


def refuses_warm_up(conn, *_):
    conn.send(("ready", None))
    while True:
        speaker, text = conn.recv()
        if text == server.WARM_TEXT:
            conn.send(("error", "в тексте нечего произносить"))
        else:
            conn.send(("ok", f"{speaker}:{text}".encode()))


class CountingLock:
    """A lock that counts how many times it was taken."""

    def __init__(self):
        self.inner = threading.Lock()
        self.taken = 0

    def acquire(self, blocking=True):
        got = self.inner.acquire(blocking)
        if got:
            self.taken += 1
        return got

    def release(self):
        self.inner.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()


def plenty():
    return 4000


def wait_for(check, seconds=5.0):
    deadline = time.monotonic() + seconds
    while not check() and time.monotonic() < deadline:
        time.sleep(0.05)
    return check()


class WorkerLife(unittest.TestCase):
    def test_FR_NOTIF_5_speaks_through_the_worker_and_unloads_after_silence(self):
        v = server.Voice(target=echo_worker, args=(), free_mb=plenty, idle_s=0.5, tick_s=0.2)
        self.assertEqual(v.speak("xenia", "привет"), "xenia:привет".encode())
        self.assertTrue(v.loaded())
        deadline = time.monotonic() + 5
        while v.loaded() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(v.loaded())
        # The next answer loads it again.
        self.assertEqual(v.speak("xenia", "снова"), "xenia:снова".encode())
        v._stop()

    def test_FR_NOTIF_5_a_load_that_fails_or_dies_is_an_error_at_once_and_the_next_request_is_not_stuck(self):
        for target in (failing_load, dies_on_load):
            v = server.Voice(target=target, args=(), free_mb=plenty)
            started = time.monotonic()
            with self.assertRaises(RuntimeError):
                v.speak("xenia", "привет")
            self.assertLess(time.monotonic() - started, 4)
            with self.assertRaises(RuntimeError):
                v.speak("xenia", "ещё")
            self.assertFalse(v.loaded())

    def test_FR_NOTIF_5_a_worker_that_dies_or_hangs_while_speaking_is_stopped(self):
        for target in (dies_on_speak, hangs_on_speak):
            v = server.Voice(target=target, args=(), free_mb=plenty)
            started = time.monotonic()
            with self.assertRaises(RuntimeError):
                v.speak("xenia", "привет")
            self.assertLess(time.monotonic() - started, 5)
            self.assertFalse(v.loaded())

    def test_FR_NOTIF_5_short_of_memory_the_model_is_not_loaded(self):
        v = server.Voice(target=echo_worker, args=(), free_mb=lambda: 300)
        with self.assertRaisesRegex(RuntimeError, "мало памяти"):
            v.speak("xenia", "привет")
        self.assertFalse(v.loaded())


class Warm(unittest.TestCase):
    """12.11.2026: /warm loaded the model, but the first phrase after it still took 6 s: it is said once here."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.log = os.path.join(self.dir, "heard.tsv")

    def heard(self):
        try:
            with open(self.log, encoding="utf-8") as f:
                return [tuple(line.rstrip("\n").split("\t")) for line in f]
        except FileNotFoundError:
            return []

    def voice(self, target=recording_worker, args=None, free_mb=plenty):
        v = server.Voice(target=target, args=(self.log,) if args is None else args, free_mb=free_mb)
        self.addCleanup(v._stop)
        return v

    def test_FR_NOTIF_5_warm_loads_the_model_and_says_one_short_phrase_in_the_speaker_asked(self):
        v = self.voice()
        v.warm(["baya"]).join(10)
        self.assertTrue(v.loaded())
        self.assertEqual(self.heard(), [("baya", "Да.")])
        # The phrase is short and is something the model can say.
        self.assertLessEqual(len(server.WARM_TEXT), 10)
        self.assertEqual(server.speakable(server.WARM_TEXT), server.WARM_TEXT)

    def test_FR_NOTIF_5_warm_without_a_speaker_warms_both_of_saras_voices(self):
        v = self.voice()
        v.warm().join(10)
        self.assertEqual(self.heard(), [("xenia", "Да."), ("baya", "Да.")])

    def test_FR_NOTIF_5_a_voice_already_warm_is_not_asked_again_until_the_worker_is_new(self):
        v = self.voice()
        v.warm(["baya"]).join(10)
        v.warm(["baya"]).join(10)
        self.assertEqual(self.heard(), [("baya", "Да.")])
        # A real phrase warms its speaker as well as the warm-up does.
        v.speak("xenia", "привет")
        v.warm(["xenia"]).join(10)
        self.assertEqual(self.heard(), [("baya", "Да."), ("xenia", "привет")])
        # After the unload the next worker is cold again.
        v._stop()
        v.warm(["baya"]).join(10)
        self.assertEqual(self.heard()[-1], ("baya", "Да."))
        self.assertEqual(len(self.heard()), 3)

    def test_FR_NOTIF_5_a_warm_up_that_kills_the_worker_does_not_break_speak(self):
        flag = os.path.join(self.dir, "died")
        v = self.voice(target=dies_on_first_warm_up, args=(flag,))
        v.warm(["baya"]).join(10)
        self.assertTrue(os.path.exists(flag))
        self.assertFalse(v.loaded())
        self.assertEqual(v.speak("baya", "привет"), "baya:привет".encode())

    def test_FR_NOTIF_5_a_warm_up_the_model_refuses_leaves_the_worker_and_speak_working(self):
        v = self.voice(target=refuses_warm_up, args=())
        v.warm(["xenia"]).join(10)
        self.assertTrue(v.loaded())
        self.assertEqual(v.speak("xenia", "привет"), "xenia:привет".encode())

    def test_FR_NOTIF_5_warm_short_of_memory_loads_nothing_and_raises_nothing(self):
        v = self.voice(free_mb=lambda: 300)
        thread = v.warm(["baya"])
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertFalse(v.loaded())
        self.assertEqual(self.heard(), [])

    def test_FR_NOTIF_5_a_warm_up_gives_the_voice_back_between_speakers(self):
        v = self.voice()
        v.lock = CountingLock()
        v.warm(["xenia", "baya"]).join(10)
        self.assertEqual([s for s, _ in self.heard()], ["xenia", "baya"])
        # One turn of the lock a speaker: a phrase of Boris waiting for it can go between the two warm-ups.
        self.assertEqual(v.lock.taken, 2)


class WarmOverHttp(unittest.TestCase):
    """The address as the core calls it: POST /warm, with or without {"speaker": ...}; always answers 202."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.log = os.path.join(self.dir, "heard.tsv")
        self.voice = server.Voice(target=recording_worker, args=(self.log,), free_mb=plenty)
        server.VOICE = self.voice
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.http.shutdown()
        self.http.server_close()
        self.voice._stop()
        server.VOICE = None

    def heard(self):
        try:
            with open(self.log, encoding="utf-8") as f:
                return [tuple(line.rstrip("\n").split("\t")) for line in f]
        except FileNotFoundError:
            return []

    def post(self, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        headers = {"Content-Type": "application/json"} if body is not None else {}
        conn.request("POST", "/warm", body=body, headers=headers)
        r = conn.getresponse()
        r.read()
        conn.close()
        return r.status

    def test_FR_NOTIF_5_the_speaker_in_the_request_is_the_one_warmed(self):
        self.assertEqual(self.post(b'{"speaker": "baya"}'), 202)
        self.assertTrue(wait_for(lambda: self.heard() == [("baya", "Да.")]))

    def test_FR_NOTIF_5_no_body_warms_xenia_and_baya(self):
        self.assertEqual(self.post(), 202)
        self.assertTrue(wait_for(lambda: self.heard() == [("xenia", "Да."), ("baya", "Да.")]))

    def test_FR_NOTIF_5_a_body_that_makes_no_sense_is_warm_for_both_and_still_202(self):
        for body in (b"not json", b'{"speaker": "nobody"}', b"[1]", b'{"speaker": ["xenia"]}', b"\xff\xfe"):
            self.voice._stop()
            if os.path.exists(self.log):
                os.remove(self.log)
            self.assertEqual(self.post(body), 202, body)
            self.assertTrue(
                wait_for(lambda: self.heard() == [("xenia", "Да."), ("baya", "Да.")]), body
            )


class Text(unittest.TestCase):
    def test_FR_NOTIF_5_only_what_the_model_can_say_reaches_it(self):
        self.assertEqual(server.speakable("Привет, <b>Борис</b> 🙂 ok"), "Привет, Борис")
        long = " ".join(["Это длинное предложение без конца"] * 60)
        parts = server.chunks(long + ". Второе.")
        self.assertTrue(all(len(p) <= server.MAX_CHUNK for p in parts))
        self.assertEqual(server.chunks("... !!!"), [])


if __name__ == "__main__":
    unittest.main()
