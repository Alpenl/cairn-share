"""One isolated source and image reference for manual-material recovery."""
import hashlib
import json


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


payload = canonical({"blocks": [{"id": "primary", "role": "primary", "text": "Manual fixture original source",
                                 "url": "", "relation": "", "acquired": "browser"}],
                     "retrieval": "browser", "truncation": {"truncated": False, "reason": ""}})
digest = hashlib.sha256(payload.encode()).hexdigest()
url = "https://example.com/android-manual-material"
print(f"INSERT INTO links(url,note,created_at,original_text,enrichment_status,ai_title,summary,translated_text) "
      f"VALUES('{url}','','t','Manual fixture original source','completed','Keep title','Keep summary','Keep translation');")
print(f"UPDATE links SET images='[\"enrichment/' || id || '/{'a' * 64}.png\"]' WHERE url='{url}';")
print("INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,completeness,created_at) "
      f"SELECT id,content_revision,'{digest}','{payload.replace(chr(39), chr(39)*2)}','complete','t' FROM links WHERE url='{url}';")
print("INSERT INTO classification_jobs(link_id,status,target_generation,spec_id,content_revision,evidence_snapshot_id,evidence_hash) "
      f"SELECT l.id,'completed',t.generation,t.spec_id,l.content_revision,s.id,s.content_hash FROM links l "
      "JOIN evidence_snapshots s ON s.link_id=l.id JOIN classification_target_state ts ON ts.id=1 "
      f"JOIN classification_targets t ON t.generation=ts.generation WHERE l.url='{url}' "
      "ON CONFLICT(link_id) DO UPDATE SET status='completed',revision=0,input_revision=0,target_generation=excluded.target_generation,spec_id=excluded.spec_id,"
      "content_revision=excluded.content_revision,evidence_snapshot_id=excluded.evidence_snapshot_id,evidence_hash=excluded.evidence_hash;")
