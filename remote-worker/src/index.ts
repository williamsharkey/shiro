/**
 * Shiro Remote Signaling Server
 *
 * A minimal WebRTC signaling server using Cloudflare Workers.
 * Handles offer/answer exchange for peer-to-peer connections.
 *
 * Endpoints:
 * - POST /offer - Register an offer with a connection code
 * - GET /offer/:code - Retrieve an offer by code (for connecting peer)
 * - POST /answer/:code - Submit an answer for a connection
 * - GET /answer/:code - Retrieve the answer (for the offering peer)
 *
 * Offers expire after 5 minutes.
 */

interface Env {
  // KV namespace for storing offers/answers
  REMOTE_KV: KVNamespace;
}

interface Offer {
  offer: RTCSessionDescriptionInit;
  candidates: RTCIceCandidateInit[];
  createdAt: number;
}

interface Answer {
  answer: RTCSessionDescriptionInit;
  candidates: RTCIceCandidateInit[];
}

// CORS headers for browser access
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (path === '/' || path === '/health') {
      return jsonResponse({ status: 'ok', service: 'shiro-remote-signaling' });
    }

    // POST /offer - Register a new offer
    if (request.method === 'POST' && path === '/offer') {
      try {
        const body = await request.json() as { code: string; offer: RTCSessionDescriptionInit; candidates: RTCIceCandidateInit[] };
        const { code, offer, candidates } = body;

        if (!code || !offer) {
          return errorResponse('Missing code or offer');
        }

        // Validate code format (adjective-noun-syllables)
        if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(code)) {
          return errorResponse('Invalid code format');
        }

        // Allow re-registration with same code (for reconnect after page reload)
        // Delete any existing answer so MCP client knows to reconnect
        await env.REMOTE_KV.delete(`answer:${code}`);

        // Store the offer with 5-minute TTL (TTL is for initial connection only)
        const offerData: Offer = {
          offer,
          candidates: candidates || [],
          createdAt: Date.now(),
        };

        await env.REMOTE_KV.put(`offer:${code}`, JSON.stringify(offerData), {
          expirationTtl: 300, // 5 minutes
        });

        return jsonResponse({ success: true, code, expiresIn: 300 });
      } catch (err: any) {
        return errorResponse(`Failed to register offer: ${err.message}`);
      }
    }

    // GET /offer/:code - Retrieve an offer
    if (request.method === 'GET' && path.startsWith('/offer/')) {
      const code = path.slice('/offer/'.length);

      if (!code) {
        return errorResponse('Missing code');
      }

      const offerData = await env.REMOTE_KV.get(`offer:${code}`);
      if (!offerData) {
        return errorResponse('Offer not found or expired', 404);
      }

      const offer: Offer = JSON.parse(offerData);
      return jsonResponse({
        offer: offer.offer,
        candidates: offer.candidates,
      });
    }

    // POST /answer/:code - Submit an answer
    if (request.method === 'POST' && path.startsWith('/answer/')) {
      const code = path.slice('/answer/'.length);

      if (!code) {
        return errorResponse('Missing code');
      }

      // Verify offer exists
      const offerData = await env.REMOTE_KV.get(`offer:${code}`);
      if (!offerData) {
        return errorResponse('Offer not found or expired', 404);
      }

      try {
        const body = await request.json() as { answer: RTCSessionDescriptionInit; candidates: RTCIceCandidateInit[] };
        const { answer, candidates } = body;

        if (!answer) {
          return errorResponse('Missing answer');
        }

        const answerData: Answer = {
          answer,
          candidates: candidates || [],
        };

        // Store the answer with 5-minute TTL
        await env.REMOTE_KV.put(`answer:${code}`, JSON.stringify(answerData), {
          expirationTtl: 300,
        });

        return jsonResponse({ success: true });
      } catch (err: any) {
        return errorResponse(`Failed to store answer: ${err.message}`);
      }
    }

    // GET /answer/:code - Retrieve an answer
    if (request.method === 'GET' && path.startsWith('/answer/')) {
      const code = path.slice('/answer/'.length);

      if (!code) {
        return errorResponse('Missing code');
      }

      const answerData = await env.REMOTE_KV.get(`answer:${code}`);
      if (!answerData) {
        // No answer yet - return 200 with waiting status (client should poll)
        return jsonResponse({ waiting: true });
      }

      const answer: Answer = JSON.parse(answerData);
      return jsonResponse(answer);
    }

    // Unknown route
    return errorResponse('Not found', 404);
  },
};
