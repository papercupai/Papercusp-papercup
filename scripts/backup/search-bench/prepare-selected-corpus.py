"""Restore a selected corpus using archived dependencies and an empty-schema DDL gate.

The manifest contains schema, archives:[{path,tables}], extensions:[name], and
indexes:[{tablename,indexname,indexdef}]. Run inside scripts/with-test-pg.mjs;
PAPERCUSP_TEST_PG_ADMIN_URL names the disposable destination. Preparation is the
default; --restore-data also loads the selected data AFTER the DDL gate passes.
No live source database or migration definition is consulted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit


# TOC parsing is used only to verify source membership/overlap. PostgreSQL owns
# the COMPLETE primary pre-data restore, including table row types required by
# function signatures. Selecting functions without their relations is unsafe.
KINDS = sorted([
    'SCHEMA', 'EXTENSION', 'TYPE', 'SHELL TYPE', 'DOMAIN', 'FUNCTION',
    'PROCEDURE', 'AGGREGATE', 'OPERATOR CLASS', 'OPERATOR FAMILY', 'OPERATOR',
    'CAST', 'COLLATION', 'CONVERSION', 'TEXT SEARCH CONFIGURATION',
    'TEXT SEARCH DICTIONARY', 'TEXT SEARCH PARSER', 'TEXT SEARCH TEMPLATE',
    'TRANSFORM', 'SEQUENCE OWNED BY', 'SEQUENCE', 'DEFAULT', 'TABLE',
], key=len, reverse=True)
ENTRY = re.compile(r'^(\d+); \d+ \d+ (' + '|'.join(KINDS) + r') (\S+) (.*?)(?: \S+)?$')
IDENTIFIER = re.compile(r'^[a-z_][a-z0-9_]*$')


def native(command, *, input=None):
    result = subprocess.run(command, input=input, text=True, capture_output=True,
                            timeout=180)
    if result.returncode:
        # Commands can carry a private connection URI. Report only the program
        # and server error; the caller retains its private wrapper's logs.
        raise RuntimeError(Path(command[0]).name + ': ' + result.stderr[-3000:])
    return result.stdout


def stable_sql(text):
    # pg_dump generates a fresh psql restriction nonce on every export. It is
    # transport framing, not a schema difference. Keep every SQL byte otherwise.
    return '\n'.join(line for line in text.splitlines()
                     if not line.startswith(('\\restrict ', '\\unrestrict '))
                     and not line.startswith('-- Dumped '))


def prepare(manifest, database, receipt, restore_data=False):
    schema = manifest['schema']
    archives = manifest['archives']
    indexes = manifest['indexes']
    tables = {table for archive in archives for table in archive['tables']}
    if not tables or not indexes or not all(IDENTIFIER.fullmatch(x) for x in [schema, *tables]):
        raise ValueError('a nonempty, simple-identifier table/index population is required')
    identities = [(i['tablename'], i['indexname']) for i in indexes]
    if len(set(identities)) != len(indexes) or {i[0] for i in identities} != tables:
        raise ValueError('index population must cover exactly the selected tables without duplicates')
    owners = [table for archive in archives for table in archive['tables']]
    if len(set(owners)) != len(owners):
        raise ValueError('each selected data table must have exactly one archive owner')

    def sql(statement):
        return native(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database], input=statement).strip()

    data_directory = Path(sql("SELECT current_setting('data_directory')")).resolve()
    if not data_directory.name.startswith(('papercusp-test-pg-', 'papercusp-native-pg-')):
        raise ValueError('destination must be a maintained disposable PostgreSQL cluster')
    # Refuse a populated/existing application schema before any restore mutation.
    if sql("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='" + schema + "')") != 'f':
        raise ValueError('destination schema must not exist')
    receipt['phases'].append('archive-preflight')
    plans = []
    extensions = set(manifest['extensions'])
    primary_path = str(Path(archives[0]['path']).resolve(strict=True))
    primary_toc = native(['pg_restore', '--section=pre-data', '--list', primary_path])
    primary_tables = {}
    restored_extensions = set()
    for line in primary_toc.splitlines():
        match = ENTRY.match(line)
        if match:
            _, kind, namespace, name = match.groups()
            name = name.strip()
            if kind == 'TABLE' and namespace == schema and name in tables:
                primary_tables[name] = line
            if kind == 'EXTENSION':
                restored_extensions.add(name)
    if set(primary_tables) != tables:
        raise ValueError('primary schema archive must contain every selected table definition')
    if not extensions.issubset(restored_extensions):
        raise ValueError('declared extensions are missing from the primary schema archive')
    receipt['restoredExtensions'] = sorted(restored_extensions)
    receipt['schemaPolicy'] = 'complete-primary-archive-pre-data'
    for position, archive in enumerate(archives):
        path = str(Path(archive['path']).resolve(strict=True))
        toc = primary_toc if position == 0 else native(['pg_restore', '--section=pre-data', '--list', path])
        present = set()
        for line in toc.splitlines():
            match = ENTRY.match(line)
            if not match:
                continue
            _, kind, namespace, name = match.groups()
            name = name.strip()
            selected = namespace == schema and kind == 'TABLE' and name in archive['tables']
            if selected:
                present.add(name)
            if selected and position > 0:
                # Compare the complete native table export, including defaults
                # and column annotations, before choosing the primary copy.
                def table_sql(source):
                    return native(['pg_restore', '--section=pre-data', '--no-owner', '--no-acl',
                                   '--schema=' + schema, '--table=' + name, '--file=-', source])
                before = table_sql(primary_path)
                after = table_sql(path)
                if stable_sql(before) != stable_sql(after):
                    raise ValueError('archive schema overlap differs: ' + repr((kind, namespace, name)))
                receipt['overlaps'].append([kind, namespace, name])
        if not set(archive['tables']).issubset(present):
            raise ValueError('selected table missing from its data archive')
        plans.append((path, archive['tables']))
        receipt['archives'].append({'path': path, 'tocSha256': hashlib.sha256(toc.encode()).hexdigest(),
                                    'restoresCompletePreData': position == 0})

    receipt['phases'].append('schema-restore')
    statement = native(['pg_restore', '--section=pre-data', '--no-owner', '--no-acl', '--file=-', primary_path])
    receipt['preDataSha256'] = hashlib.sha256(stable_sql(statement).encode()).hexdigest()
    sql(statement)
    for table in sorted(tables):
        if sql('SELECT EXISTS (SELECT 1 FROM ' + schema + '.' + table + ' LIMIT 1)') != 'f':
            raise ValueError('preflight destination is not empty: ' + table)
    receipt['phases'].append('empty-schema-index-preflight')
    receipt['declaredIndexes'] = len(indexes)
    # One connection and transaction: validate the COMPLETE population, inspect
    # PostgreSQL's resulting definitions/readiness, then roll back every index.
    population_query = "SELECT coalesce(json_agg(row_to_json(i) ORDER BY tablename,indexname),'[]') FROM (SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='" + schema + "') i;"
    validation_query = "SELECT count(*) FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='" + schema + "' AND (NOT x.indisvalid OR NOT x.indisready);"
    script = 'BEGIN;\n' + '\n'.join(i['indexdef'].rstrip(';') + ';' for i in indexes)
    # Quiet psql still emits result rows; markers avoid parsing command tags.
    script += '\nSELECT \'INDEX_POPULATION\';\n' + population_query + '\nSELECT \'INVALID_INDEXES\';\n' + validation_query + '\nROLLBACK;\n'
    output = sql(script).splitlines()
    actual = json.loads(output[output.index('INDEX_POPULATION') + 1])
    expected = sorted(indexes, key=lambda i: (i['tablename'], i['indexname']))
    if actual != expected or output[output.index('INVALID_INDEXES') + 1] != '0':
        raise ValueError('complete index definition/readiness population differs')
    if json.loads(sql(population_query)) != []:
        raise ValueError('preflight indexes were not rolled back')
    receipt['preflightPassed'] = True
    receipt['validatedIndexes'] = len(actual)
    receipt['phases'].append('empty-schema-index-preflight-passed')
    if restore_data:
        receipt['phases'].append('data-restore')
        for path, selected in plans:
            if selected:
                native(['pg_restore', '--dbname=' + database, '--data-only', '--no-owner', '--no-acl',
                        '--exit-on-error', '--schema=' + schema,
                        *['--table=' + table for table in selected], path])
        receipt['dataRestored'] = True
    receipt['phases'].append('completed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--restore-data', action='store_true')
    args = parser.parse_args()
    database = os.environ['PAPERCUSP_TEST_PG_ADMIN_URL']
    endpoint = urlsplit(database)
    if endpoint.hostname not in ('127.0.0.1', 'localhost', '::1') or not endpoint.port or endpoint.port == 5432:
        raise ValueError('requires a disposable loopback PostgreSQL destination')
    receipt = {'schemaVersion': 1, 'phases': [], 'archives': [], 'overlaps': [],
               'manifestSha256': hashlib.sha256(Path(args.manifest).read_bytes()).hexdigest(),
               'sourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'preflightPassed': False, 'dataRestored': False}
    destination = Path(args.receipt)
    # Fail before touching a database if this edition already has evidence.
    with destination.open('x') as stream:
        try:
            prepare(json.loads(Path(args.manifest).read_text()), database,
                    receipt, args.restore_data)
        except Exception as error:
            receipt['failure'] = {'type': type(error).__name__, 'message': str(error).replace(database, '<private-db>')}
        finally:
            json.dump(receipt, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
    print(json.dumps({'receipt': str(destination), 'preflightPassed': receipt['preflightPassed'],
                      'dataRestored': receipt['dataRestored'], 'failure': receipt.get('failure')}))
    return 1 if 'failure' in receipt else 0


if __name__ == '__main__':
    sys.exit(main())
