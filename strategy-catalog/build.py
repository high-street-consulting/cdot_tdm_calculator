#!/usr/bin/env python3
"""
build.py — validate the strategy catalog and compile it to a single JSON the
app can consume.

Usage:
    python3 build.py            # validate + compile to compiled/strategies.json
    python3 build.py --check    # validate only (CI mode; non-zero exit on error)

What it does:
  1. Loads schema/strategy.schema.json and globals.yaml.
  2. Loads every strategies/*.yaml, validates each against the schema.
  3. Cross-checks: unique id + uid; category exists in globals; every select
     input has options; default value is consistent with the control; tags are
     in the tag_catalog; referenced image files exist.
  4. Emits compiled/strategies.json: { generated_at, categories, area_type_thresholds,
     tag_catalog, strategies: [...] } with a `defaults` map derived per strategy
     for backward-compat with the app registry shape.
  5. Prints a content-completeness report (which narrative/image/instruction
     fields are still blank) so editors have a punch list.

Dependencies: pyyaml, jsonschema  (pip install pyyaml jsonschema)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys

import yaml

try:
    from jsonschema import Draft202012Validator as _Validator
except ImportError:  # jsonschema < 4
    from jsonschema import Draft7Validator as _Validator

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "schema", "strategy.schema.json")
GLOBALS_PATH = os.path.join(HERE, "globals.yaml")
STRAT_DIR = os.path.join(HERE, "strategies")
TODO_DIR = os.path.join(STRAT_DIR, "todo")
IMG_DIR = os.path.join(HERE, "images")
OUT_DIR = os.path.join(HERE, "compiled")
OUT_PATH = os.path.join(OUT_DIR, "strategies.json")


def _load_yaml(path):
    with open(path) as f:
        return yaml.safe_load(f)


def _flatten_tags(tag_catalog):
    out = set()
    for group in (tag_catalog or {}).values():
        out.update(group)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="validate only, no output file")
    args = ap.parse_args()

    errors = []
    warnings = []
    todos = []

    schema = json.load(open(SCHEMA_PATH))
    validator = _Validator(schema)
    g = _load_yaml(GLOBALS_PATH)
    cat_ids = {c["id"] for c in g.get("categories", [])}
    valid_tags = _flatten_tags(g.get("tag_catalog"))

    files = sorted(f for f in os.listdir(STRAT_DIR) if f.endswith((".yaml", ".yml")))
    if not files:
        errors.append(f"No strategy files found in {STRAT_DIR}")

    strategies = []
    seen_id, seen_uid = {}, {}

    for fn in files:
        path = os.path.join(STRAT_DIR, fn)
        try:
            rec = _load_yaml(path)
        except yaml.YAMLError as e:
            errors.append(f"{fn}: YAML parse error: {e}")
            continue
        if not isinstance(rec, dict):
            errors.append(f"{fn}: top-level must be a mapping")
            continue

        # Schema validation
        for err in sorted(validator.iter_errors(rec), key=lambda e: e.path):
            loc = "/".join(str(p) for p in err.path) or "(root)"
            errors.append(f"{fn}: {loc}: {err.message}")

        sid = rec.get("id")
        uid = rec.get("uid")

        # Filename should match id
        if sid and fn not in (f"{sid}.yaml", f"{sid}.yml"):
            warnings.append(f"{fn}: filename does not match id '{sid}' (expected {sid}.yaml)")

        # Uniqueness
        if sid in seen_id:
            errors.append(f"{fn}: duplicate id '{sid}' (also in {seen_id[sid]})")
        seen_id[sid] = fn
        if uid in seen_uid:
            errors.append(f"{fn}: duplicate uid '{uid}' (also in {seen_uid[uid]})")
        seen_uid[uid] = fn

        # Category exists
        if rec.get("category") not in cat_ids:
            errors.append(f"{fn}: category '{rec.get('category')}' not in globals.yaml categories")

        # Tags in catalog
        for t in rec.get("tags") or []:
            if t not in valid_tags:
                warnings.append(f"{fn}: tag '{t}' not in globals.yaml tag_catalog")

        # Per-input checks
        defaults = {}
        for inp in rec.get("inputs") or []:
            key = inp.get("key")
            ctrl = inp.get("control")
            dflt = inp.get("default")
            defaults[key] = dflt
            if ctrl == "select":
                opts = {o["value"] for o in inp.get("options", [])}
                if dflt not in opts:
                    errors.append(f"{fn}: input '{key}' default '{dflt}' not among options {sorted(opts)}")
            elif ctrl in ("slider", "number"):
                if not isinstance(dflt, (int, float)):
                    errors.append(f"{fn}: input '{key}' ({ctrl}) default must be numeric, got {dflt!r}")
            # TODO tracking
            if not (inp.get("instructions") or "").strip():
                todos.append(f"{sid}: input '{key}' has no instructions")

        # Image existence
        for img in rec.get("images") or []:
            ip = os.path.join(IMG_DIR, img["file"])
            if not os.path.exists(ip):
                errors.append(f"{fn}: image file not found: images/{img['file']}")

        # TODO tracking (narrative)
        if not (rec.get("extended_description") or "").strip():
            todos.append(f"{sid}: extended_description is empty")
        if not (rec.get("images") or []):
            todos.append(f"{sid}: no images (will fall back to category image)")

        # Backward-compat registry shape
        rec["_defaults"] = defaults
        strategies.append(rec)

    # ---- Report ----
    print(f"Validated {len(strategies)} strategy file(s).")
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  ERROR {e}")

    if errors:
        print(f"\n✗ {len(errors)} error(s). No output written.")
        sys.exit(1)

    print(f"\n✓ Schema + cross-checks passed ({len(warnings)} warning(s)).")

    # Completeness punch list (live strategies only)
    if todos:
        print(f"\nContent to fill in ({len(todos)} item(s)):")
        for t in todos:
            print(f"  TODO  {t}")

    # ---- Stubs in strategies/todo/ — validated but NOT compiled ----
    if os.path.isdir(TODO_DIR):
        todo_files = sorted(f for f in os.listdir(TODO_DIR) if f.endswith((".yaml", ".yml")))
        todo_errors = []
        by_status = {}
        for fn in todo_files:
            try:
                rec = _load_yaml(os.path.join(TODO_DIR, fn))
            except yaml.YAMLError as e:
                todo_errors.append(f"todo/{fn}: YAML parse error: {e}")
                continue
            for err in sorted(validator.iter_errors(rec), key=lambda e: e.path):
                loc = "/".join(str(p) for p in err.path) or "(root)"
                todo_errors.append(f"todo/{fn}: {loc}: {err.message}")
            sid, uid = rec.get("id"), rec.get("uid")
            if sid in seen_id:
                todo_errors.append(f"todo/{fn}: id '{sid}' collides with live {seen_id[sid]}")
            if uid in seen_uid:
                todo_errors.append(f"todo/{fn}: uid '{uid}' collides with live {seen_uid[uid]}")
            by_status[rec.get("status")] = by_status.get(rec.get("status"), 0) + 1
        summary = ", ".join(f"{v} {k}" for k, v in sorted(by_status.items()))
        print(f"\nStubs in strategies/todo/ (not compiled): {len(todo_files)} file(s) — {summary}")
        for e in todo_errors:
            print(f"  STUB-ERROR {e}")

    if args.check:
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    payload = {
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "categories": g.get("categories", []),
        "area_type_thresholds": g.get("area_type_thresholds", {}),
        "tag_catalog": g.get("tag_catalog", {}),
        "strategies": strategies,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {os.path.relpath(OUT_PATH, HERE)} ({len(strategies)} strategies).")


if __name__ == "__main__":
    main()
