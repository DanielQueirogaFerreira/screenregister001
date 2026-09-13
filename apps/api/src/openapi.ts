/**
 * Hand-written OpenAPI document.
 *
 * Exists so that clients without MCP support — scripts, or an assistant wired up through
 * a generic HTTP action — can reach the same reads the MCP tools expose. It describes the
 * read surface an outside consumer needs, not the ingest routes the recorder uses.
 */
export const OPENAPI = (origin: string) => ({
  openapi: '3.1.0',
  info: {
    title: 'ScreenRegister',
    version: '0.1.0',
    description:
      "Read access to a user's screen history for roughly the last 7 days. Every stored " +
      'frame is a moment the screen changed; unchanged stretches collapse into a single ' +
      'frame with a long hold_ms, so gaps between frame timestamps mean "nothing changed", ' +
      'not "no data". Prefer /v1/scenes to survey a period and /v1/timeline to pinpoint a ' +
      'moment; fetch images only for the frames that matter.',
  },
  servers: [{ url: origin }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'A ScreenRegister API token (srp_…), created under Settings > Account & security. ' +
          'Use a read-scoped token: it can read this history but cannot record, delete, or ' +
          'create further tokens.',
      },
    },
  },
  paths: {
    '/v1/sessions': {
      get: { summary: "The caller's recording sessions, newest first", responses: { 200: { description: 'Sessions' } } },
    },
    '/v1/data': {
      delete: {
        summary: "Permanently delete every session, frame row and stored image belonging to the caller",
        responses: { 200: { description: 'Counts of what was removed' } },
      },
    },
    '/v1/scenes': {
      get: {
        summary: 'Collapse a period into scenes',
        description:
          'Runs where the screen stayed essentially the same. The cheapest way to survey a ' +
          'stretch of time — a full day usually reduces to a few dozen scenes.',
        parameters: [
          { name: 'last_hours', in: 'query', schema: { type: 'number', default: 24 } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'min_scene_ms', in: 'query', schema: { type: 'number', default: 5000 } },
        ],
        responses: { 200: { description: 'Scenes, each naming the frame that opened it' } },
      },
    },
    '/v1/search': {
      get: {
        summary: 'Find moments by what the screen showed',
        description:
          'The only route that knows WHAT was on screen rather than WHEN it changed. Text ' +
          'comes from OCR run on the recording device, so it carries OCR\'s error rate and ' +
          'a miss is not proof of absence. The response carries a `coverage` object — ' +
          '`searchable` frames hold text, `unread` frames could not be read at all and are ' +
          'invisible to this search by construction, `total` is everything stored. When ' +
          '`searchable` is 0 an empty result means "nothing to search", never "no match". ' +
          'Each result carries `ocr_confidence`, the reader\'s mean confidence for that ' +
          'frame: near 1 is a clean read, near 0.5 barely a read at all.',
        parameters: [
          {
            name: 'q', in: 'query', required: true, schema: { type: 'string' },
            description: 'Words that must all appear in one frame, in any order',
          },
          { name: 'last_hours', in: 'query', schema: { type: 'number', default: 24 } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'number', default: 50, maximum: 200 } },
        ],
        responses: {
          200: { description: 'Matching moments, with coverage for what could not be searched' },
          400: { description: 'No q parameter' },
        },
      },
    },
    '/v1/timeline': {
      get: {
        summary: 'Individual stored frames, as metadata only',
        parameters: [
          { name: 'last_hours', in: 'query', schema: { type: 'number', default: 24 } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          {
            name: 'min_change', in: 'query', schema: { type: 'number' },
            description: 'Only frames where at least this fraction (0-1) of the screen changed',
          },
          {
            name: 'reason', in: 'query',
            schema: { type: 'string', enum: ['first', 'scene_change', 'settled', 'burst', 'heartbeat', 'final'] },
          },
          { name: 'limit', in: 'query', schema: { type: 'number', default: 100, maximum: 500 } },
        ],
        responses: { 200: { description: 'Frame records' } },
      },
    },
    '/v1/frames/{frame_id}/image': {
      get: {
        summary: 'The screen image at one moment',
        parameters: [
          { name: 'frame_id', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'variant', in: 'query', schema: { type: 'string', enum: ['full', 'thumb'], default: 'full' },
            description: 'thumb is ~320px wide and much cheaper',
          },
        ],
        responses: { 200: { description: 'WebP image', content: { 'image/webp': {} } } },
      },
    },
    '/v1/usage': {
      get: { summary: 'Frame count, byte total and oldest frame', responses: { 200: { description: 'Usage' } } },
    },
  },
});
