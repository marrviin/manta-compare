import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { routeOpenPaths } from './openWith';

// routeOpenPaths resolves path kinds through the `path_kind` command; mock the
// whole module so no filesystem is touched and kinds are scripted per test.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

/** Script `path_kind` results: map from path to "dir" | "file" | "missing". */
function scriptKinds(kinds: Record<string, string>) {
  invokeMock.mockImplementation(async (_cmd: string, args?: unknown) => {
    const { path } = args as { path: string };
    return kinds[path];
  });
}

const navigate = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  navigate.mockReset();
});

describe('routeOpenPaths', () => {
  it('routes two dirs to folder-compare with left/right state', async () => {
    scriptKinds({ '/a': 'dir', '/b': 'dir' });
    await routeOpenPaths(navigate, ['/a', '/b']);
    expect(navigate).toHaveBeenCalledWith('/folder-compare', {
      state: { left: '/a', right: '/b' },
    });
  });

  it('routes two files to text-compare with left/right state', async () => {
    scriptKinds({ '/x.txt': 'file', '/y.txt': 'file' });
    await routeOpenPaths(navigate, ['/x.txt', '/y.txt']);
    expect(navigate).toHaveBeenCalledWith('/text-compare', {
      state: { left: '/x.txt', right: '/y.txt' },
    });
  });

  it('picks the first two dirs out of a larger mixed batch', async () => {
    scriptKinds({ '/d1': 'dir', '/f.txt': 'file', '/d2': 'dir' });
    await routeOpenPaths(navigate, ['/d1', '/f.txt', '/d2']);
    expect(navigate).toHaveBeenCalledWith('/folder-compare', {
      state: { left: '/d1', right: '/d2' },
    });
  });

  it('opens a lone dir with only the left side set', async () => {
    scriptKinds({ '/only': 'dir' });
    await routeOpenPaths(navigate, ['/only']);
    expect(navigate).toHaveBeenCalledWith('/folder-compare', {
      state: { left: '/only' },
    });
  });

  it('opens a lone file with only the left side set', async () => {
    scriptKinds({ '/only.txt': 'file' });
    await routeOpenPaths(navigate, ['/only.txt']);
    expect(navigate).toHaveBeenCalledWith('/text-compare', {
      state: { left: '/only.txt' },
    });
  });

  it('a dir + file batch routes the dir to folder-compare (documents current behavior)', async () => {
    scriptKinds({ '/d': 'dir', '/f.txt': 'file' });
    await routeOpenPaths(navigate, ['/d', '/f.txt']);
    expect(navigate).toHaveBeenCalledWith('/folder-compare', {
      state: { left: '/d' },
    });
  });

  it('falls back to text-compare in first-two order when kind detection fails', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await routeOpenPaths(navigate, ['/a', '/b', '/c']);
    expect(navigate).toHaveBeenCalledWith('/text-compare', {
      state: { left: '/a', right: '/b' },
    });
  });

  it('a single failing path still opens the fallback page with one side', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    await routeOpenPaths(navigate, ['/a']);
    expect(navigate).toHaveBeenCalledWith('/text-compare', {
      state: { left: '/a' },
    });
  });

  it('does nothing for an empty or blank-only batch', async () => {
    await routeOpenPaths(navigate, []);
    await routeOpenPaths(navigate, ['', '']);
    expect(navigate).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
