# Evaluation fixtures

`minimal-pairs.jsonl` contains one focused positive and one hard negative for every initial rule. These examples are synthetic and MIT-licensed with the project; they are regression fixtures, not a representative Korean corpus.

Schema:

```json
{
  "id": "rule-positive-or-negative",
  "text": "Korean input",
  "profile": "optional profile",
  "expect": ["rule IDs that must appear"],
  "reject": ["rule IDs that must not appear"],
  "source": "synthetic",
  "license": "MIT"
}
```

Add real-world data only with explicit redistribution rights and row-level provenance. Never commit private user copy.
