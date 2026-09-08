import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import store, { initialVisualizationSettings, updateSettings } from '../store';

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
  applyRendererDefaults: () => ({}),
}));

jest.mock('../utils/progressApi', () => ({
  clearTaskTree: () => {},
  setActiveDatasetLoadTask: () => {},
}));

jest.mock('./PredefinedDatasets', () => ({
  __esModule: true,
  default: ({ onChange }: { onChange: (entry: { path: string; type: string; display: string; datasetType: string }) => void }) => (
    <button
      type="button"
      onClick={() =>
        onChange({
          path: 'data/cctv/manifest.json',
          type: 'json',
          display: 'CCTV dataset',
          datasetType: 'cctv',
        })
      }
    >
      CCTV dataset
    </button>
  ),
}));

// jest.mock calls above are hoisted before this import, so the component
// resolves against the mocked modules exactly as the former require() did.
import DatasetTabPanel from './DatasetTabPanel';

describe('DatasetTabPanel preset timing', () => {
  beforeEach(() => {
    pendingByPath.clear();
    mockLoadDatasetAuto.mockClear();
    store.dispatch(updateSettings(initialVisualizationSettings));
  });

  it('applies dataset visual preset before dataset promise resolves', () => {
    const onDataSelected = jest.fn();

    render(
      <Provider store={store}>
        <DatasetTabPanel onDataSelected={onDataSelected} />
      </Provider>,
    );

    expect(store.getState().visualizationSettings.colorEncoding).toBe('algo');

    fireEvent.click(screen.getByRole('button', { name: 'CCTV dataset' }));

    expect(mockLoadDatasetAuto).toHaveBeenCalledTimes(1);
    expect(store.getState().visualizationSettings.colorEncoding).toBe('line');
    expect(onDataSelected).not.toHaveBeenCalled();
  });
});
