function schemaFor(candidate) {
  return candidate.lifecycleV11?.skuPackage?.c1ProductPlan?.inputSnapshots?.platformSchemaRules;
}

function colorFieldsComplete(schema) {
  const colors = schema?.attributes?.filter(item => String(item.fieldKey) === '10096') ?? [];
  const names = schema?.attributes?.filter(item => String(item.fieldKey) === '10097') ?? [];
  if (colors.length !== 1 || names.length !== 1 || !Number.isSafeInteger(colors[0].dictionaryId) ||
      colors[0].dictionaryId <= 0) return false;
  return colors[0].isCollection !== true ||
    Number.isSafeInteger(colors[0].maxValueCount) && colors[0].maxValueCount > 0;
}

/** Display-only preparation state. The use case revalidates evidence and identity at submission. */
export function siblingBatchSchemaPreparation(candidates) {
  const sources = candidates.filter(candidate => {
    const read = candidate.lifecycleV11?.c1SchemaRefreshV1;
    return read?.status === 'succeeded' && read.evidencePackId === schemaFor(candidate)?.evidenceId;
  }).sort((left, right) => Date.parse(right.lifecycleV11.c1SchemaRefreshV1.settledAt) -
    Date.parse(left.lifecycleV11.c1SchemaRefreshV1.settledAt));
  const source = sources[0] ?? null;
  const sourceComplete = source !== null && colorFieldsComplete(schemaFor(source));
  const rows = candidates.map(candidate => {
    const schema = schemaFor(candidate);
    const read = candidate.lifecycleV11?.c1SchemaRefreshV1;
    let action;
    if (read?.status === 'request_sent' || read?.status === 'unknown_outcome') action = 'reconcile';
    else if (source && !sourceComplete) action = 'evidence_missing';
    else if (source && schema?.evidenceId !== schemaFor(source).evidenceId) action = 'adopt';
    else if (colorFieldsComplete(schema)) action = 'ready';
    else action = 'read';
    return { candidateId: candidate.id, action, evidencePackId: schema?.evidenceId ?? null };
  });
  return { source, evidencePackId: source ? schemaFor(source).evidenceId : null,
    rows, ready: rows.length > 0 && rows.every(row => row.action === 'ready') };
}
