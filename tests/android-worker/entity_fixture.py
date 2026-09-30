"""Seed stored synthetic judgments; no inference and no human-reference labels."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
fixture = json.loads((root / "worker/test/fixtures/entity-observations-v1.json").read_text())
observations = fixture["state"]["entities"]["observations"]
blocks = [{"id": name, "text": "Acme", "role": "primary" if name == "a" else "quoted",
           **({"url": "https://example.com/" + name} if name != "c" else {})} for name in "abc"]


def choice(selected, options):
    return {"type": "choice", "choice": selected, "confidence": 1,
            "probabilities": {key: int(key == selected) for key in options}}


for observation in observations:
    observation.pop("effective")
    observation["relevance"] = choice("relevant", ["relevant", "incidental", "none", "unknown"])
    observation["canonical_options"] = []
    if observation["canonical_id"] is not None:
        selected = "id:" + observation["canonical_id"]
        observation["canonical"] = choice(selected, ["none", "unknown", selected])
        observation["canonical_options"] = [{"entity": {
            "id": observation["canonical_id"], "label": "Acme", "kind": "project", "aliases": [],
            "identifiers": [item["identifier"] for item in observation["canonical_evidence"]]},
            "evidence": observation["canonical_evidence"]}]


def sql(value):
    return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'"


print("INSERT INTO links(url,note,created_at,original_text) VALUES('https://example.com/android-entity','','t','Acme');")
print("INSERT INTO evidence_snapshots(link_id,content_revision,content_hash,payload,created_at) "
      f"SELECT id,content_revision,'{'a' * 64}',{sql({'blocks': blocks})},'t' FROM links WHERE url='https://example.com/android-entity';")
print("INSERT INTO entity_states(link_id,state,content_revision,content_hash,evidence_snapshot_id,entities,observations,revision,updated_at) "
      f"SELECT l.id,'completed_nonempty',l.content_revision,s.content_hash,s.id,'[\"Acme\"]',{sql(observations)},1,'t' "
      "FROM links l JOIN evidence_snapshots s ON s.link_id=l.id WHERE l.url='https://example.com/android-entity';")
