"""The voice service's worker life without the model (ADR-028): a load that fails, a worker that dies or hangs, the
memory guard and the unload after silence must never leave the service waiting forever.

    python3 -I -m unittest discover -s infra/voice -p 'test_*.py'
"""
import os
import time
import unittest

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


def plenty():
    return 4000


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


class Text(unittest.TestCase):
    def test_FR_NOTIF_5_only_what_the_model_can_say_reaches_it(self):
        self.assertEqual(server.speakable("Привет, <b>Борис</b> 🙂 ok"), "Привет, Борис")
        long = " ".join(["Это длинное предложение без конца"] * 60)
        parts = server.chunks(long + ". Второе.")
        self.assertTrue(all(len(p) <= server.MAX_CHUNK for p in parts))
        self.assertEqual(server.chunks("... !!!"), [])


if __name__ == "__main__":
    unittest.main()
