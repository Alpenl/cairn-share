#!/usr/bin/env python3
"""Loopback-only transport fault injector; all business responses come from Worker."""
import http.client
import http.server
import json
import socket
import sys
import threading
import urllib.parse
import uuid

upstream = urllib.parse.urlsplit(sys.argv[1])
state = {"mode": "online", "key": "", "requests": [], "selection_reads": [], "deletes": [], "web_writes": 0}
lock = threading.Lock()


def forward(method, path, body, headers):
    connection = http.client.HTTPConnection(upstream.hostname, upstream.port, timeout=15)
    try:
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def do_DELETE(self):
        self.handle_request()

    def drop(self):
        self.close_connection = True
        self.connection.shutdown(socket.SHUT_RDWR)
        self.connection.close()

    def respond(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/__test/control":
            with lock:
                if self.command == "POST":
                    change = json.loads(body)
                    assert change["mode"] in ("online", "offline", "writes_offline", "lose_first", "conflict", "fail_key", "lose_delete")
                    state.update(mode=change["mode"], key=change.get("key", ""))
                data = json.dumps(state).encode()
            return self.respond(200, data)
        # Direct inspection is still authenticated by the real Worker.
        direct = self.path.startswith("/__test/direct/")
        path = self.path.removeprefix("/__test/direct") if direct else self.path
        headers = {"Authorization": self.headers.get("Authorization", ""), "Content-Type": "application/json"}
        mutation = not direct and self.command == "POST" and path.endswith("/v2-override")
        deletion = not direct and self.command == "DELETE" and path.startswith("/api/links/")
        action = json.loads(body) if mutation else {}
        with lock:
            mode, key = state["mode"], state["key"]
            if deletion:
                state["deletes"].append(path)
                if mode == "lose_delete": state["mode"] = "offline"
            if mutation:
                state["requests"].append(action)
                if mode in ("lose_first", "fail_key") and (mode == "lose_first" or key == action["operation_key"]):
                    state["mode"] = "offline"
                if mode == "conflict" and key == action["operation_key"]:
                    state["mode"] = "online"
                    state["web_writes"] += 1
        if not direct and (mode == "offline" or (mode == "writes_offline" and mutation)):
            return self.drop()
        if mutation and mode == "fail_key" and key == action["operation_key"]:
            return self.drop()
        if mutation and mode == "conflict" and key == action["operation_key"]:
            # A distinct client commits between Android's read and CAS. This
            # uses the real human-action endpoint, not a fabricated 409.
            web = dict(action, term="eng", field="topics", action="accept", operation_key="web-" + str(uuid.uuid4()))
            status, result = forward("POST", path, json.dumps(web).encode(), headers)
            assert status == 200, (status, result)
        status, result = forward(self.command, path, body or None, headers)
        if not direct and self.command == "GET" and urllib.parse.urlsplit(path).path.endswith("/v2-selection"):
            # Record only route/status, never credentials or response bodies.
            # UI messages can be replaced by concurrent list refresh failures.
            with lock:
                state["selection_reads"].append({"path": urllib.parse.urlsplit(path).path, "status": status})
        if deletion and mode == "lose_delete":
            assert status == 204, (status, result)
            return self.drop()
        if mutation and mode == "lose_first":
            assert status == 200, (status, result)
            return self.drop()
        self.respond(status, result)


http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), Handler).serve_forever()
