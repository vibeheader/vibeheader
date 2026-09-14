/**
 * @jest-environment jsdom
 */

describe('share-page content bridge', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    delete global.chrome;
    jest.restoreAllMocks();
  });

  test('echoes request IDs and returns only safe import result fields', async () => {
    const postMessage = jest.spyOn(window, 'postMessage')
      .mockImplementation(() => {});
    const sendMessage = jest.fn(async () => ({
      success: true,
      data: {
        name: 'Imported Profile',
        active: true,
        headers: [{ name: 'Authorization', value: 'secret', comment: 'Saved note' }],
        filters: []
      }
    }));
    global.chrome = { runtime: { sendMessage } };

    await import('../src/content/content-script.js');
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: {
        type: 'VIBE_PING',
        requestId: 'ping-123'
      }
    }));

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'VIBE_ACK',
      requestId: 'ping-123',
      protocols: [1, 2],
      features: expect.arrayContaining(['headerComments'])
    }), '*');

    postMessage.mockClear();
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: {
        type: 'VIBE_IMPORT_V2',
        requestId: 'import-123',
        payload: {
          v: 2,
          n: 'Imported Profile',
          h: [['X-Test', '1']],
          f: [],
          c: ['Server note']
        }
      }
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith({
      action: 'importSharedProfile',
      data: { v: 2, n: 'Imported Profile', h: [['X-Test', '1']], f: [],
        c: ['Server note'] }
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'VIBE_RESULT',
      requestId: 'import-123',
      success: true,
      data: {
        profileName: 'Imported Profile',
        active: true
      },
      error: undefined
    }, '*');
    expect(postMessage.mock.calls[0][0]).not.toHaveProperty('headers');
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('Saved note');

    sendMessage.mockClear();
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { type: 'VIBE_IMPORT', v: 2, n: 'Legacy message envelope',
        h: [['X-Test', '1']], f: [], c: ['Server note'] }
    }));
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith({
      action: 'importSharedProfile',
      data: { v: 2, n: 'Legacy message envelope', h: [['X-Test', '1']], f: [],
        c: ['Server note'] }
    });
  });
});
