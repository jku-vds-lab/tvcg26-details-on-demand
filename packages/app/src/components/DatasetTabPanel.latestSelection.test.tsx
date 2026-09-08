import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import store from '../store';

const mockApplyRendererDefaults = jest.fn();
const mockClearTaskTree = jest.fn();

const pendingByPath = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }
>();

const mockLoadDatasetAuto = jest.fn((path: string, options?: { signal?: AbortSignal }) => {
  return new Promise<unknown>((resolve, reject) => {
    pendingByPath.set(path, { resolve, reject });

    const signal = options?.signal;
    if (!signal) return;

    const onAbort = () => reject(new DOMException('Dataset load aborted', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
});

jest.mock('../dataPreprocessing/DatasetLoader', () => ({
  loadDatasetAuto: (path: string, options?: { signal?: AbortSignal }) =>
    mockLoadDatasetAuto(path, options),
}));

jest.mock('../dataPreprocessing/JSONLoader', () => ({
  JSONLoader: class {
    resolveContent() {}
    resolveParsed() {}
  },
}));

jest.mock('../dataPreprocessing/CSVLoader', () => ({
  CSVLoader: class {
    resolveVectors() {}
  },
}));

jest.mock('../workers/makeJsonWorker', () => ({
  makeJsonWorker: () => ({
    postMessage: () => {},
    terminate: () => {},
    onmessage: null,
    onerror: null,
  }),
}));

jest.mock('../workers/makeSimplePreprocessWorker', () => ({
  makeSimplePreprocessWorker: () => ({
    postMessage: () => {},
    terminate: () => {},
    onmessage: null,
    onerror: null,
  }),
}));

jest.mock('../utils/clusterDataUtils', () => ({
  applyRendererDefaults: (...args: unknown[]) => mockApplyRendererDefaults(...args),
}));

jest.mock('../utils/progressApi', () => ({
  clearTaskTree: (...args: unknown[]) => mockClearTaskTree(...args),
  setActiveDatasetLoadTask: () => {},
}));

jest.mock('./PredefinedDatasets', () => ({
  __esModule: true,
  default: ({ onChange }: { onChange: (entry: { path: string; type: string; display: string; datasetType: string }) => void }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onChange({
            path: 'data/first/manifest.json',
            type: 'json',
            display: 'First dataset',
            datasetType: 'first',
          })
        }
      >
        First dataset
      </button>
      <button
        type="button"
        onClick={() =>
          onChange({
            path: 'data/second/manifest.json',
            type: 'json',
            display: 'Second dataset',
            datasetType: 'second',
          })
        }
      >
        Second dataset
      </button>
    </div>
  ),
}));

// jest.mock calls above are hoisted before this import, so the component
// resolves against the mocked modules exactly as the former require() did.
import DatasetTabPanel from './DatasetTabPanel';

describe('DatasetTabPanel latest selection wins', () => {
  beforeEach(() => {
    pendingByPath.clear();
    mockLoadDatasetAuto.mockClear();
    mockApplyRendererDefaults.mockClear();
    mockClearTaskTree.mockClear();
  });

  it('ignores the first request and only applies the latest dataset on rapid clicks', async () => {
    const onDataSelected = jest.fn();

    render(
      <Provider store={store}>
        <DatasetTabPanel onDataSelected={onDataSelected} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'First dataset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Second dataset' }));

    expect(mockLoadDatasetAuto).toHaveBeenCalledTimes(2);

    pendingByPath.get('data/first/manifest.json')?.resolve({
      data: [{ x: 1, y: 1, line: 0, algo: 'A', action: '0' }],
      knnGraph: [],
      datasetType: 'first',
    });

    await waitFor(() => {
      expect(onDataSelected).not.toHaveBeenCalled();
    });

    pendingByPath.get('data/second/manifest.json')?.resolve({
      data: [{ x: 2, y: 2, line: 0, algo: 'B', action: '1' }],
      knnGraph: [],
      datasetType: 'second',
    });

    await waitFor(() => {
      expect(onDataSelected).toHaveBeenCalledTimes(1);
    });

    const selected = onDataSelected.mock.calls[0][0] as { datasetType: string; data: { x: number }[] };
    expect(selected.datasetType).toBe('second');
    expect(selected.data[0].x).toBe(2);
    expect(mockApplyRendererDefaults).toHaveBeenCalledTimes(1);
    expect(mockApplyRendererDefaults).toHaveBeenCalledWith('second');
    expect(mockClearTaskTree).toHaveBeenCalledTimes(1);
    expect(mockClearTaskTree.mock.calls[0][0]).toContain('data/first/manifest.json');
  });
});
