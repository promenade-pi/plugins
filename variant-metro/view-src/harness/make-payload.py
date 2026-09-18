#!/usr/bin/env python3
"""Regenerates `harness/payload.json` — the fixture the view harness renders.

    python3 view-src/harness/make-payload.py

Uses `check.py`'s own order log (three variants at known frequencies, plus a
shared employee), runs it through `variants.py`, and lays it out with the real
wasm-side conversion via `cargo run --example build_map`. So the fixture is a
genuine artifact payload, not hand-written JSON that could drift from what the
plugin actually produces.

Pass `--log <ocel2.json>` to build the fixture from a real OCEL 2.0 JSON file
instead (bigger, better for judging how a busy diagram reads).
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.abspath(os.path.join(HERE, '..', '..'))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def from_ocel(path):
    """The three OCEL tables, in the shape `variants.py`'s `prepare` returns."""
    raw = json.load(open(path))
    type_of = {o['id']: o['type'] for o in raw['objects']}
    activity_of, ts_of, objects_by_event = {}, {}, {}
    events_by_object = defaultdict(list)
    for event in raw['events']:
        eid = event['id']
        activity_of[eid] = event['type']
        stamp = event['time'].replace('Z', '+00:00')
        try:
            ts_of[eid] = datetime.fromisoformat(stamp).timestamp() * 1000.0
        except ValueError:
            ts_of[eid] = 0.0
        oids = [r['objectId'] for r in event.get('relationships') or [] if r['objectId'] in type_of]
        objects_by_event[eid] = oids
        for oid in oids:
            events_by_object[oid].append(eid)
    for oid in events_by_object:
        events_by_object[oid].sort(key=lambda e: (ts_of[e], e))
    return {
        'type_of': type_of, 'activity_of': activity_of, 'ts_of': ts_of,
        'objects_by_event': objects_by_event, 'events_by_object': dict(events_by_object),
    }


class Ctx:
    def log(self, message):
        print(f'  {message}')

    def progress(self, fraction, message='', data=None):
        pass


parser = argparse.ArgumentParser()
parser.add_argument('--log', help='an OCEL 2.0 JSON file to build the fixture from')
parser.add_argument('--leading-type', default=None)
parser.add_argument('--out', default=os.path.join(HERE, 'payload.json'))
args = parser.parse_args()

variants = load('variants', os.path.join(PLUGIN, 'variants.py'))
if args.log:
    data = from_ocel(args.log)
    leading = args.leading_type
else:
    check = load('check', os.path.join(PLUGIN, 'check.py'))
    data = check.order_log()
    leading = args.leading_type or 'order'

params = {
    'extraction': 'leadingType', 'leadingType': leading or '',
    'maxEvents': 300, 'maxVariants': 25, 'maxObjectTypes': 12, 'scopeSharedObjects': True,
}
dfg = variants.finalize(data, params, Ctx())
print(f"  {dfg['stats']}")

with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as tmp:
    json.dump(dfg, tmp)
    staged = tmp.name
subprocess.run(['cargo', 'run', '--quiet', '--release', '--example', 'build_map', staged, args.out],
               cwd=PLUGIN, check=True)
os.unlink(staged)
payload = json.load(open(args.out))
print(f"  wrote {args.out}: {len(payload['nodes'])} nodes, {len(payload['edges'])} edges, "
      f"{payload['sliderPositions']} slider positions")
