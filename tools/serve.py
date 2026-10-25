"""Local test server that never lets the browser cache files.

Usage (from the project folder):  python tools/serve.py   ->  http://localhost:8000
The plain `python -m http.server` lets the browser keep old app.js/styles.css,
so a fresh edit may not show up while testing.
"""
import http.server
import os
import sys

# PORT env (set by the preview launcher when the asked port is busy) wins over the argument
PORT = int(os.environ.get('PORT') or (sys.argv[1] if len(sys.argv) > 1 else 8000))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), NoCacheHandler) as httpd:
        print(f'Serving {os.path.abspath(ROOT)} at http://localhost:{PORT} (no cache)')
        httpd.serve_forever()
