getapi :

https://trace.triratnaakolayouth.com/trace/vu38dc588.zip?testExecutionId=testexecution1234

{
  "success": true,
  "message": "Trace viewer started",
  "sessionId": "d1fe9d980c8d5ec9c150183a8d61a491",
  "viewer": "http://trace.triratnaakolayouth.com/viewer/d1fe9d980c8d5ec9c150183a8d61a491/",
  "testExecutionId": "testexecution1234",
  "filename": "vu38dc588.zip",
  "vuid": "vu38dc588",
  "port": 9325,
  "expiresIn": "10 minutes",
  "activeViewers": 3,
  "maxViewers": 20
}

## Production HTTPS note

In production, HTTPS may be handled by a proxy before the request reaches Node.js. The proxy must tell Node.js that the original request was HTTPS:

```http
X-Forwarded-Proto: https
```

`server.js` has this setting so Express can detect HTTPS correctly:

```javascript
app.set("trust proxy", 1);
```

The viewer URL should start with `https://`. If it still starts with `http://`, configure the proxy to send `X-Forwarded-Proto: https`.