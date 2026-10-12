import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  maskEmails,
  redactErrorEvent,
  redactHeaders,
  redactString,
  redactUrl,
  redactValue,
} from '../src/core/index';

// Corpo REAL do TeaTime (POST /auth/signin, /auth/password-reset/confirm, PATCH /user/me/password).
const signin = { email: 'ana.souza@ciag.org.br', password: 'S3nh@Forte!' };
const resetConfirm = {
  verificationToken: 'f1c0ffee-0000-4000-8000-000000000001',
  newPassword: 'Nova#Senha1',
  confirmedNewPassword: 'Nova#Senha1',
};

describe('redação de PII (campos do contrato)', () => {
  const cases: Array<[string, unknown]> = [
    ['authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
    ['Authorization', 'Bearer abc.def.ghi'],
    ['cookie', 'gp_session=abc'],
    ['set-cookie', ['gp_session=abc; HttpOnly']],
    ['Set-Cookie', 'x=1'],
    ['senha', '123456'],
    ['password', 'S3nh@Forte!'],
    ['newPassword', 'Nova#Senha1'],
    ['confirmedNewPassword', 'Nova#Senha1'],
    ['token', 'abc'],
    ['accessToken', 'abc'],
    ['access_token', 'abc'],
    ['verificationToken', 'f1c0ffee'],
    ['secret', 's'],
    ['client_secret', 's'],
  ];
  it.each(cases)('%s é trocado por [REDACTED] em qualquer profundidade', (key, value) => {
    const input = { level1: { list: [{ [key]: value, keep: 'ok' }] } };
    const out = redactValue(input);
    expect(out.level1.list[0]).toEqual({ [key]: REDACTED, keep: 'ok' });
    // não altera o original
    expect(input.level1.list[0]![key as keyof (typeof input.level1.list)[0]]).toEqual(value);
  });

  it('corpo real de login: senha some, e-mail mascarado', () => {
    expect(redactValue(signin)).toEqual({ email: 'a***@ciag.org.br', password: REDACTED });
  });

  it('corpo real de troca de senha: os três campos somem', () => {
    expect(redactValue(resetConfirm)).toEqual({
      verificationToken: REDACTED,
      newPassword: REDACTED,
      confirmedNewPassword: REDACTED,
    });
  });

  it('chaves não sensíveis continuam (id, userId, status)', () => {
    expect(isSensitiveKey('userId')).toBe(false);
    expect(isSensitiveKey('id')).toBe(false);
    expect(isSensitiveKey('tokenType')).toBe(false);
    expect(redactValue({ userId: 'u1', status: 401 })).toEqual({ userId: 'u1', status: 401 });
  });
});

describe('e-mail e credenciais em texto livre', () => {
  it('mascara e-mails: a***@ciag.org.br', () => {
    expect(maskEmails('Usuário ana.souza@ciag.org.br não encontrado')).toBe('Usuário a***@ciag.org.br não encontrado');
    expect(maskEmails('x@y.com, Bob.Smith+tag@sub.example.co.uk')).toBe('x***@y.com, B***@sub.example.co.uk');
  });
  it('remove Bearer/Basic e JWT soltos', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dGVzdHNpZ25hdHVyZQ';
    expect(redactString(`header Bearer ${jwt}`)).toBe(`header Bearer ${REDACTED}`);
    expect(redactString(`token=${jwt}`)).toBe(`token=${REDACTED}`);
    expect(redactString('Basic dXNlcjpwYXNzd29yZA==')).toBe(`Basic ${REDACTED}`);
  });
  it('URL: parâmetros sensíveis trocados, o resto mantido', () => {
    expect(redactUrl('/auth/verify?token=abc123&next=/home')).toBe(`/auth/verify?token=${REDACTED}&next=/home`);
    expect(redactUrl('https://x/reset?verificationToken=1&email=ana@ciag.org.br#f')).toBe(
      `https://x/reset?verificationToken=${REDACTED}&email=a***@ciag.org.br#f`,
    );
    expect(redactUrl('/projects/123')).toBe('/projects/123');
  });
  it('Error: mensagem e stack com redação, tipo preservado', () => {
    const err = new TypeError('falha para ana@ciag.org.br');
    const out = redactValue({ err });
    expect(out.err).toBeInstanceOf(Error);
    expect(out.err.message).toBe('falha para a***@ciag.org.br');
    expect(out.err.name).toBe('TypeError');
  });
  it('ciclos não travam', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactValue(a)).toEqual({ name: 'a', self: '[Circular]' });
  });
  it('cabeçalhos', () => {
    expect(redactHeaders({ authorization: 'Bearer x', cookie: 'a', 'user-agent': 'UA' })).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'user-agent': 'UA',
    });
  });
});

describe('beforeSend (evento de erro)', () => {
  it('usuário só por id; corpo e cookies descartados; cabeçalhos/URL/mensagem com redação', () => {
    const event = {
      message: 'falha no login de ana@ciag.org.br',
      user: { id: 42, email: 'ana@ciag.org.br', ip_address: '10.0.0.1', username: 'ana' },
      request: {
        url: 'https://api/auth/reset?token=abc',
        query_string: 'token=abc&page=2',
        data: JSON.stringify(signin),
        cookies: { gp: '1' },
        headers: { Authorization: 'Bearer abcdefghijkl', 'User-Agent': 'UA' },
      },
      breadcrumbs: [{ message: 'POST /auth/signin', data: { password: 'x', email: 'bob@ciag.org.br' } }],
      extra: { body: resetConfirm },
      tags: { errorId: 'req-12345678' },
    };
    const out = redactErrorEvent(event);
    expect(out.user).toEqual({ id: '42' });
    expect(out.request).toEqual({
      url: `https://api/auth/reset?token=${REDACTED}`,
      query_string: `token=${REDACTED}&page=2`,
      headers: { Authorization: REDACTED, 'User-Agent': 'UA' },
    });
    expect(out.message).toBe('falha no login de a***@ciag.org.br');
    expect(out.breadcrumbs[0]!.data).toEqual({ password: REDACTED, email: 'b***@ciag.org.br' });
    expect(out.extra.body).toEqual({
      verificationToken: REDACTED,
      newPassword: REDACTED,
      confirmedNewPassword: REDACTED,
    });
    expect(out.tags).toEqual({ errorId: 'req-12345678' });
    expect(JSON.stringify(out)).not.toMatch(/S3nh@|Nova#|ana@|ana\.souza|10\.0\.0\.1/);
  });
  it('usuário sem id é removido', () => {
    expect(redactErrorEvent({ user: { email: 'a@b.com' } }).user).toBeUndefined();
  });
});
