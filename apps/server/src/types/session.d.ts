import '@fastify/session';

declare module 'fastify' {
  interface Session {
    userId?: string;
    oauthState?: string;
    oauthCodeVerifier?: string;
    oauthProvider?: 'google' | 'github';
    oauthNext?: string;
  }
}

declare module '@fastify/session' {
  interface FastifySessionObject {
    userId?: string;
    oauthState?: string;
    oauthCodeVerifier?: string;
    oauthProvider?: 'google' | 'github';
    oauthNext?: string;
  }
}

export {};
