#!/usr/bin/env python3
"""
VTM Support Highway — pre-build API smoke test
Run this before every new version build.
Usage: python3 smoke_test_highway.py

Credentials: bill.bell@versaterm.com + token from secrets.local.json
"""
import json, urllib.parse, urllib.request, base64, sys, os

SECRETS_PATH = '/home/vdxiii/dev/vtm-support-highway/secrets.local.json'
JIRA_USER    = 'bill.bell@versaterm.com'
JIRA_BASE    = 'https://versaterminc.atlassian.net'
TEST_ISSUE   = 'CRMS-1'        # just needs to exist; we only check status code
TEST_PROJECT = 'CRMS'
TEST_ZD_KEY  = 'ZD-132516'     # used in JQL search

# ── load token ────────────────────────────────────────────────────────────────
if not os.path.exists(SECRETS_PATH):
    print(f'ERROR: {SECRETS_PATH} not found — recreate it with the shared token')
    sys.exit(1)
token = json.load(open(SECRETS_PATH))['jiraPass']
auth  = base64.b64encode(f'{JIRA_USER}:{token}'.encode()).decode()
headers = {'Authorization': f'Basic {auth}', 'Accept': 'application/json'}

passed = 0
failed = 0

def test(label, url, expect_keys=None):
    global passed, failed
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            data = json.loads(r.read())
            if expect_keys:
                missing = [k for k in expect_keys if k not in data]
                if missing:
                    print(f'  WARN  {label} — missing keys: {missing}')
                else:
                    print(f'  PASS  {label}')
                    passed += 1
            else:
                print(f'  PASS  {label}')
                passed += 1
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        print(f'  FAIL  {label} — HTTP {e.code}: {body}')
        failed += 1
    except Exception as e:
        print(f'  FAIL  {label} — {e}')
        failed += 1

print(f'\n=== VTM Support Highway API Smoke Test ===')
print(f'Jira Cloud: {JIRA_BASE}')
print(f'User: {JIRA_USER}\n')

# 1. JQL search (v3 — no backslash escaping on brackets)
jql = f'summary ~ "[{TEST_ZD_KEY}]" ORDER BY created DESC'
test('Jira v3 JQL search',
    JIRA_BASE + '/rest/api/3/search/jql?jql=' + urllib.parse.quote(jql) + '&maxResults=1&fields=summary',
    expect_keys=['issues'])

# 2. Fetch issue
test('Jira fetch issue (v2)',
    JIRA_BASE + f'/rest/api/2/issue/{TEST_ISSUE}?fields=summary,status',
    expect_keys=['key', 'fields'])

# 3. Create meta — paginated form (v2 Cloud endpoint)
test('Jira createmeta issuetypes (v2)',
    JIRA_BASE + f'/rest/api/2/issue/createmeta/{TEST_PROJECT}/issuetypes?maxResults=50')

# 4. Project (for issue types / components)
test('Jira project (v2)',
    JIRA_BASE + f'/rest/api/2/project/{TEST_PROJECT}',
    expect_keys=['issueTypes'])

# 5. Components
test('Jira components (v2)',
    JIRA_BASE + f'/rest/api/2/project/{TEST_PROJECT}/components')

# 6. Remote links
test('Jira remote links (v2)',
    JIRA_BASE + f'/rest/api/2/issue/{TEST_ISSUE}/remotelink')

print(f'\nResult: {passed} passed, {failed} failed')
if failed:
    print('FIX FAILURES BEFORE BUILDING THE ZIP.')
    sys.exit(1)
else:
    print('All good — safe to build.')
