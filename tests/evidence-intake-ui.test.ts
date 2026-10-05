import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildBioNexusReceipt, buildDoiInput, buildGenericReceipt, evidenceRecordView } from '../src/evidence-intake-ui.js';
import { verifyDoi } from '../src/doi-verification.js';
import type { Resource } from '../src/domain.js';

function receiptForm(status = 'succeeded') {
  const data = new FormData();
  data.set('toolName','Synthetic DE test'); data.set('toolVersion','test-1'); data.set('executionStatus',status);
  return data;
}
test('browser receipt builder binds exact raw bytes, including BOM/CRLF notebook and CSV bytes', async () => {
  const code = new File(['{"cells":[{"cell_type":"code","source":["DO_NOT_RUN"]}]}'],'analysis.ipynb');
  const inputBytes = new Uint8Array([239,187,191,97,44,98,13,10,49,44,50,13,10]);
  const output = new File(['gene,padj\r\nX,0.02\r\n'],'result.csv');
  const bundle = await buildGenericReceipt(receiptForm(),{ receiptCode:[code],receiptInputs:[new File([inputBytes],'counts.csv')],receiptOutputs:[output] });
  assert.equal(bundle.manifest.code.path,'code/analysis.ipynb');
  const uploaded = bundle.files.find(file => file.path === 'inputs/counts.csv')!;
  assert.deepEqual(Buffer.from(uploaded.contentBase64,'base64'),Buffer.from(inputBytes));
  assert.equal(bundle.manifest.inputs[0].sha256,createHash('sha256').update(inputBytes).digest('hex'));
  assert.equal(bundle.manifest.outputs[0].sha256,createHash('sha256').update(await output.text()).digest('hex'));
  assert.equal(bundle.manifest.status,'succeeded');
});

test('receipt intake does not manufacture successful outputs or erase failure records', async () => {
  const groups = { receiptCode:[new File(['code'],'x.py')],receiptInputs:[new File(['input'],'x.csv')],receiptOutputs:[] };
  await assert.rejects(buildGenericReceipt(receiptForm(),groups),/输出/);
  const failed = receiptForm('failed');
  await assert.rejects(buildGenericReceipt(failed,groups),/失败/);
  failed.set('failures','model fitting failed\nno output emitted');
  const receipt = await buildGenericReceipt(failed,groups);
  assert.deepEqual(receipt.manifest.outputs,[]);
  assert.equal(receipt.manifest.failures.length,2);
  const duplicate = {...groups,receiptInputs:[new File(['A'],'same.csv'),new File(['B'],'same.csv')]};
  await assert.rejects(buildGenericReceipt(failed,duplicate),/重复/);
});

test('BioNexus intake preserves selected relative paths and rejects ambiguous input modes', async () => {
  const data = new FormData(); data.set('executionReceiptPath','execution.json');
  const file = new File(['{"test":true}'],'manifest.json');
  Object.defineProperty(file,'webkitRelativePath',{value:'chosen-bundle/manifest.json'});
  const result = await buildBioNexusReceipt(data,{bionexusFiles:[file]}) as { format:string;files:Array<{path:string;contentBase64:string}>;executionReceiptPath:string };
  assert.equal(result.files[0].path,'manifest.json');
  assert.equal(result.executionReceiptPath,'execution.json');
  assert.equal(Buffer.from(result.files[0].contentBase64,'base64').toString(),'{"test":true}');
  await assert.rejects(buildBioNexusReceipt(data,{bionexusFiles:[file],receiptPackage:[file]}),/一种/);
  await assert.rejects(buildBioNexusReceipt(data,{receiptPackage:[new File(['not JSON'],'bad.json')]}),/有效 JSON/);
});

test('DOI view preserves unverified layers and escapes untrusted bibliographic text', async () => {
  const data = new FormData(); data.set('doi','10.1234/test'); data.set('verificationMode','syntax_only');
  data.set('expectedTitle','<script>DO_NOT_RUN</script>'); data.set('expectedAuthors','A Person\nB Person');
  const input = buildDoiInput(data);
  assert.deepEqual(input.expected?.authors,['A Person','B Person']);
  const verification = await verifyDoi(input);
  const resource = { id:'test-resource',name:'DOI',mediaType:'application/json',content:'{}',sha256:'0'.repeat(64),sourceKind:'user_upload',evidenceKind:'doi_verification',doiVerification:verification } as Resource;
  const html = evidenceRecordView(resource);
  assert.match(html,/未查询/);
  assert.match(html,/论文内容支持论断/);
  assert.match(html,/&lt;script&gt;DO_NOT_RUN&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>/);
});
