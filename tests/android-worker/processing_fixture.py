"""One missing primary with real media and retained human/reading state."""
import hashlib
import json

url = "https://x.com/processing/status/9004"
context = "Stored image context"
payload = json.dumps({"blocks": [{"id": "image", "role": "legacy_unknown", "text": context,
                                  "url": url, "relation": "Unknown image authorship", "acquired": "browser"}],
                      "retrieval": "browser", "truncation": {"truncated": True, "reason": "browser_limit"}},
                     sort_keys=True, separators=(",", ":"), ensure_ascii=False)
digest = hashlib.sha256(payload.encode()).hexdigest()
image = "enrichment/9004/" + "a" * 64 + ".png"
images = json.dumps([{"key": image, "content_type": "image/png"}], separators=(",", ":"))
print(f"INSERT INTO links(id,url,note,created_at,original_text,source_context_text,images,related_links,enrichment_status,ai_title,summary,translated_text,personal_revision) "
      f"VALUES(9004,'{url}','','t',NULL,'{context}','{images}','[]','completed','Keep title','Keep summary','Keep translation',1);")
print("INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,truncated,completeness,created_at) "
      f"SELECT id,content_revision,'{digest}','{payload}',1,'truncated','t' FROM links WHERE id=9004;")
print("INSERT INTO classification_jobs(link_id,status,revision,input_revision,target_generation,spec_id,content_revision,evidence_snapshot_id,evidence_hash) "
      "SELECT l.id,'waiting_source',7,9,t.generation,t.spec_id,l.content_revision,s.id,s.content_hash FROM links l "
      "JOIN evidence_snapshots s ON s.link_id=l.id JOIN classification_target_state ts ON ts.id=1 "
      "JOIN classification_targets t ON t.generation=ts.generation WHERE l.id=9004;")
print("INSERT INTO curation_overrides(link_id,field,term,action,source,confirmed,revision,operation_key,created_at) "
      "VALUES(9004,'use','contra','accept','human',1,1,'processing-human','t');")
print("INSERT INTO curation_events(link_id,kind,payload,revision,operation_key,created_at) "
      "VALUES(9004,'why','{\"why\":\"Keep human record\"}',1,'processing-event','t');")
