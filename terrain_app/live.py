"""Live updates pushed to every open page (the PC and any headset) over one WebSocket each.

Events are small JSON objects such as {"type": "job", "id": …, "progress": .4} or {"type": "terrain", "id": …}.
A page that misses events while asleep catches up from the normal API after it reconnects.
"""
import json
from queue import Empty, Full, Queue
from threading import Lock
import uuid

PING_SECONDS = 15   # keeps idle connections open through Wi-Fi power saving and lets the page notice a dead link


class Hub:
    def __init__(self):
        self.boot = uuid.uuid4().hex   # changes when the server restarts, so pages know to resync
        self._lock = Lock()
        self._queues = set()

    def publish(self, event):
        with self._lock:
            queues = list(self._queues)
        for queue in queues:
            try:
                queue.put_nowait(event)
            except Full:
                pass  # a stalled page; it resyncs when it reconnects

    def serve(self, ws):
        queue = Queue(maxsize=200)
        with self._lock:
            self._queues.add(queue)
        try:
            ws.send(json.dumps({"type": "hello", "boot": self.boot}))
            while True:
                try:
                    event = queue.get(timeout=PING_SECONDS)
                except Empty:
                    event = {"type": "ping"}
                ws.send(json.dumps(event))
                # Drain anything the page sent (its own pings); a closed socket raises here or on send.
                while ws.receive(timeout=0) is not None:
                    pass
        finally:
            with self._lock:
                self._queues.discard(queue)

    @property
    def listeners(self):
        with self._lock:
            return len(self._queues)
