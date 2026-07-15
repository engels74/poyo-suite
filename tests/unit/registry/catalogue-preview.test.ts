import { describe, expect, test } from 'bun:test';
import { imageCatalogue } from '../../../src/lib/features/registry/catalogue';
import { normalizeImageRequest } from '../../../src/lib/features/registry/normalize';
describe('registry catalogue and preview foundations', () => {
  test('REG-06 catalogue searches provider, model ID and workflow with capability DTOs', () => {
    expect(imageCatalogue('ByteDance').length).toBeGreaterThan(0);
    expect(
      imageCatalogue('seedream-5.0-pro').some((item) => item.publicModelId === 'seedream-5.0-pro')
    ).toBe(true);
    expect(imageCatalogue('image-edit').every((item) => item.workflow === 'image-edit')).toBe(true);
    expect(imageCatalogue()[0]).toHaveProperty('inputRoles');
  });
  test('REG-03 golden vector normalizes exact snake-case Poyo input', () => {
    expect(
      normalizeImageRequest('nano-banana-2-official-edit:image-edit', {
        prompt: 'restyle',
        imageUrls: ['https://assets.example/a.png'],
        aspectRatio: '1:1',
        resolution: '2K',
        outputFormat: 'png',
        seed: 42,
        googleSearch: true
      }).request
    ).toEqual({
      model: 'nano-banana-2-official-edit',
      input: {
        prompt: 'restyle',
        size: '1:1',
        resolution: '2K',
        output_format: 'png',
        seed: 42,
        google_search: true,
        image_urls: ['https://assets.example/a.png']
      }
    });
  });
});
