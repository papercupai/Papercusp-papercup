---
rel_path: "audits/held-agent-resumption-2026-10-12/auto-directed-recovery-2026-10-20.json"
updated_at: 1792495452360
_body: "content"
---

{
  "at": "2026-10-20T11:24:12.331Z",
  "out": [
    {
      "owner": "su-0d52d810-afcc-4f52-8863-4a92600f9485",
      "id": "EI-25553824038716206",
      "receipt": {
        "ok": true,
        "results": [
          {
            "ok": true,
            "to": [
              "su-0d52d810-afcc-4f52-8863-4a92600f9485"
            ],
            "msg_id": "coord-send-fe2c52fe79ef22d13ac881a1e89bd2e6e326a86db97c13766114568cbb0c0380",
            "ts": "2026-10-20T11:24:12.061Z",
            "federated": true,
            "federationScope": "papercusp",
            "receiptEvent": "coord:receipt:coord-send-fe2c52fe79ef22d13ac881a1e89bd2e6e326a86db97c13766114568cbb0c0380",
            "wake": {
              "mode": "required",
              "targets": [
                "su-0d52d810-afcc-4f52-8863-4a92600f9485"
              ],
              "queued": 1,
              "woken": 1,
              "pickupConfirmed": false,
              "wakeOutcome": "queued"
            },
            "bodyTruncated": false,
            "bodyMayBeTruncated": true,
            "bodyAuthoredChars": 571,
            "bodyFullChars": 571,
            "bodyDeliveredChars": 571,
            "bodyDeliveryCap": 600,
            "bodyCrowdedPageCap": 300,
            "bodyReadRef": {
              "tool": "coord:read",
              "msg_id": "coord-send-fe2c52fe79ef22d13ac881a1e89bd2e6e326a86db97c13766114568cbb0c0380"
            }
          }
        ],
        "counts": {
          "ok": 1,
          "failed": 0
        }
      }
    },
    {
      "owner": "su-60df5d22-d045-4660-bdbc-ff602879d3a8",
      "id": "EI-25561320530819600",
      "receipt": {
        "ok": true,
        "results": [
          {
            "ok": true,
            "to": [
              "su-60df5d22-d045-4660-bdbc-ff602879d3a8"
            ],
            "msg_id": "coord-send-a39f6f4b6c33ba0311792a797e4820a18c89fd1c0151eb5f411bf4f06b4f6901",
            "ts": "2026-10-20T11:24:12.166Z",
            "federated": true,
            "federationScope": "papercusp",
            "bodyTruncated": false,
            "bodyMayBeTruncated": true,
            "bodyAuthoredChars": 421,
            "bodyFullChars": 421,
            "bodyDeliveredChars": 421,
            "bodyDeliveryCap": 600,
            "bodyCrowdedPageCap": 300,
            "bodyReadRef": {
              "tool": "coord:read",
              "msg_id": "coord-send-a39f6f4b6c33ba0311792a797e4820a18c89fd1c0151eb5f411bf4f06b4f6901"
            },
            "chunk": {
              "group": "c5b803d8",
              "part": 1,
              "of": 2
            }
          },
          {
            "ok": true,
            "to": [
              "su-60df5d22-d045-4660-bdbc-ff602879d3a8"
            ],
            "msg_id": "coord-send-82641481277178e97dc8cca94914692b5738f64388135fcc314074cc5bed9399",
            "ts": "2026-10-20T11:24:12.273Z",
            "federated": true,
            "federationScope": "papercusp",
            "receiptEvent": "coord:receipt:coord-send-82641481277178e97dc8cca94914692b5738f64388135fcc314074cc5bed9399",
            "wake": {
              "mode": "required",
              "targets": [
                "su-60df5d22-d045-4660-bdbc-ff602879d3a8"
              ],
              "queued": 1,
              "woken": 1,
              "pickupConfirmed": false,
              "wakeOutcome": "queued"
            },
            "bodyTruncated": false,
            "bodyMayBeTruncated": false,
            "bodyAuthoredChars": 224,
            "bodyFullChars": 224,
            "bodyDeliveredChars": 224,
            "bodyDeliveryCap": 600,
            "bodyCrowdedPageCap": 300,
            "chunk": {
              "group": "c5b803d8",
              "part": 2,
              "of": 2
            }
          }
        ],
        "counts": {
          "ok": 2,
          "failed": 0
        },
        "chunked": [
          {
            "group": "c5b803d8",
            "parts": 2,
            "msgIds": [
              "coord-send-a39f6f4b6c33ba0311792a797e4820a18c89fd1c0151eb5f411bf4f06b4f6901",
              "coord-send-82641481277178e97dc8cca94914692b5738f64388135fcc314074cc5bed9399"
            ],
            "askMsgId": "coord-send-82641481277178e97dc8cca94914692b5738f64388135fcc314074cc5bed9399"
          }
        ],
        "chunkedNote": "A body over the inbox cap was delivered in full as ordered parts, each fully visible in a normal inbox read. Only the final part (askMsgId) carries expects, the wake and reply threading; earlier parts are expects:none continuations."
      }
    }
  ]
}
