export function isRetiredImageInput(publicModelId: string, inputKey: string): boolean {
  return (
    inputKey === 'n' &&
    (publicModelId === 'seedream-5.0-pro' || publicModelId === 'seedream-5.0-pro-edit')
  );
}
