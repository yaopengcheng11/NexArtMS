import fs from 'node:fs';
import path from 'node:path';
import {createStudioStore} from '../studio/db.mjs';
import {createShotAnalysisStore} from '../studio/shot-analysis-store.mjs';
import {importSessionAnalysis} from '../studio/shot-analysis-session.mjs';

const [dataRoot, inputFile] = process.argv.slice(2);
if (!dataRoot || !inputFile) throw new Error('Usage: node scripts/import-session-shot-analysis.mjs DATA_ROOT ANNOTATIONS_JSON');
const root = path.resolve(dataRoot), input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
// Do not reset active job state merely to import a review into a running local server.
const store = createStudioStore(root, {recoverInterrupted: false});
try {
  const analysisStore = createShotAnalysisStore(store, root);
  const result = await importSessionAnalysis({store, analysisStore, root, input});
  console.log(JSON.stringify({projectId: result.projectId, runId: result.id, status: result.status, counts: result.counts, subjects: result.subjects.map(({id, kind, name}) => ({id, kind, name})), source: result.parameters.analysisSource}));
} finally {store.close();}
