import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { currentBettor } from '@/lib/auth';
import { buildContext, SYSTEM_PROMPT } from '@/lib/assistant';

export const dynamic = 'force-dynamic';

/**
 * The in-app assistant.
 *
 * Signed in only. The context includes who has how many points and what is on
 * the board, which is league business rather than public -- and the key is
 * billed per call, so an open endpoint is somebody else's bill.
 */
export async function POST(request) {
  const slug = await currentBettor();
  if (!slug) {
    return NextResponse.json({ error: 'Sign in to ask.' }, { status: 403 });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: 'The assistant is not configured yet.' },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return NextResponse.json({ error: 'Ask something.' }, { status: 400 });
  }

  // Only the last few turns. A chat window this small does not need a long
  // memory, and every turn resent is paid for again.
  const recent = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  try {
    const context = await buildContext();
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 700,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        // Cached: the context is ~13k tokens and barely changes between
        // questions, so re-reading it every turn would be most of the bill.
        { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
      ],
      messages: recent,
    });

    const text = res.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    return NextResponse.json({ ok: true, reply: text });
  } catch (e) {
    // The real error goes to the server log; the window gets something useful.
    console.error('assistant:', e?.message ?? e);
    const status = e?.status === 401 ? 'That API key was rejected.' : 'That did not work.';
    return NextResponse.json({ error: status }, { status: 502 });
  }
}
