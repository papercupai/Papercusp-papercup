"""Loopback-only viewer for the finished owner-requested audit artifact."""
import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HERE=Path(__file__).resolve().parent
ROUTES={'/':('report.html','text/html; charset=utf-8'),'/report.html':('report.html','text/html; charset=utf-8'),
        '/audit.json':('audit.json','application/json; charset=utf-8'),'/report.md':('report.md','text/markdown; charset=utf-8')}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        requested=urlsplit(self.path).path
        route=ROUTES.get(requested)
        if not route:
            self.send_error(404)
            return
        body=(HERE/route[0]).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type',route[1])
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-cache')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('ETag','"'+hashlib.sha256(body).hexdigest()+'"')
        self.end_headers()
        self.wfile.write(body)


server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
url='http://localhost:'+str(server.server_port)+'/'
(HERE/'viewer.json').write_text(json.dumps({'url':url,'bind':'127.0.0.1','port':server.server_port,'pid':os.getpid(),
                                           'source':str(HERE/'report.html'),'audit':'WI-10006272'},indent=2)+'\n')
print(url,flush=True)
server.serve_forever()
