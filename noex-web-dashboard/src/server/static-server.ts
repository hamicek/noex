/**
 * Static file server for serving the built Svelte SPA.
 *
 * Provides Express middleware for:
 * - Serving static assets (JS, CSS, images)
 * - SPA fallback routing (index.html for client-side routes)
 * - Cache headers for optimal performance
 * - Security headers for production deployment
 *
 * @module server/static-server
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

// =============================================================================
// Constants
// =============================================================================

/** Cache duration for immutable assets (hashed filenames). */
const IMMUTABLE_CACHE_MAX_AGE = 31536000; // 1 year in seconds

/** Cache duration for mutable assets (index.html). */
const MUTABLE_CACHE_MAX_AGE = 0;

/** File extensions considered as static assets. */
const STATIC_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.map',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
]);

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the static file server.
 */
export interface StaticServerConfig {
  /** Port for the HTTP server. @default 3000 */
  readonly port: number;
  /** Path to the static files directory. @default './dist/client' */
  readonly staticPath: string;
  /** Host to bind to. @default '0.0.0.0' */
  readonly host: string;
}

/**
 * Events emitted by the static server.
 */
export type StaticServerEvent =
  | { readonly type: 'listening'; readonly port: number; readonly host: string }
  | { readonly type: 'request'; readonly method: string; readonly path: string; readonly status: number }
  | { readonly type: 'error'; readonly error: Error };

/**
 * Event handler for static server events.
 */
export type StaticServerEventHandler = (event: StaticServerEvent) => void;

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: StaticServerConfig = {
  port: 3000,
  staticPath: './dist/client',
  host: '0.0.0.0',
};

// =============================================================================
// StaticServer Class
// =============================================================================

/**
 * Static file server for the Svelte SPA.
 *
 * Serves built client assets with proper caching and SPA routing support.
 * All non-asset requests are served the index.html for client-side routing.
 *
 * @example
 * ```typescript
 * const server = new StaticServer({
 *   port: 3000,
 *   staticPath: './dist/client',
 * });
 *
 * server.onEvent((event) => {
 *   if (event.type === 'listening') {
 *     console.log(`Server running at http://localhost:${event.port}`);
 *   }
 * });
 *
 * const httpServer = await server.start();
 * ```
 */
export class StaticServer {
  private readonly config: StaticServerConfig;
  private readonly handlers = new Set<StaticServerEventHandler>();
  private readonly app: Express;

  private server: HttpServer | null = null;
  private readonly absoluteStaticPath: string;
  private readonly indexHtmlPath: string;

  constructor(config: Partial<StaticServerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.app = express();
    this.absoluteStaticPath = resolve(this.config.staticPath);
    this.indexHtmlPath = join(this.absoluteStaticPath, 'index.html');

    this.setupMiddleware();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Returns the Express application instance.
   *
   * Useful for attaching additional middleware or routes before starting.
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * Returns the HTTP server instance, if started.
   */
  getHttpServer(): HttpServer | null {
    return this.server;
  }

  /**
   * Creates an HTTP server without starting it.
   *
   * Useful when the server needs to be passed to other components
   * (e.g., WebSocketHandler) before listening.
   */
  createHttpServer(): HttpServer {
    if (!this.server) {
      this.server = createServer(this.app);
    }
    return this.server;
  }

  /**
   * Registers an event handler for server events.
   *
   * @param handler - Callback invoked on each event
   * @returns Unsubscribe function
   */
  onEvent(handler: StaticServerEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Starts the HTTP server.
   *
   * @returns Promise that resolves with the HTTP server when listening
   */
  async start(): Promise<HttpServer> {
    return new Promise((resolve, reject) => {
      const httpServer = this.createHttpServer();

      httpServer.once('error', (error: Error) => {
        this.emit({ type: 'error', error });
        reject(error);
      });

      httpServer.listen(this.config.port, this.config.host, () => {
        this.emit({
          type: 'listening',
          port: this.config.port,
          host: this.config.host,
        });
        resolve(httpServer);
      });
    });
  }

  /**
   * Stops the HTTP server gracefully.
   *
   * @returns Promise that resolves when the server is closed
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.server = null;
          resolve();
        }
      });
    });
  }

  // ===========================================================================
  // Private Methods - Middleware Setup
  // ===========================================================================

  private setupMiddleware(): void {
    this.app.use(this.securityHeaders());
    this.app.use(this.requestLogger());
    this.app.use(this.staticFiles());
    this.app.use(this.spaFallback());
  }

  /**
   * Security headers middleware.
   */
  private securityHeaders(): (req: Request, res: Response, next: NextFunction) => void {
    return (_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    };
  }

  /**
   * Request logging middleware.
   */
  private requestLogger(): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      res.on('finish', () => {
        this.emit({
          type: 'request',
          method: req.method,
          path: req.path,
          status: res.statusCode,
        });
      });
      next();
    };
  }

  /**
   * Static file serving middleware with appropriate cache headers.
   */
  private staticFiles(): express.RequestHandler {
    return express.static(this.absoluteStaticPath, {
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        const ext = extname(filePath).toLowerCase();

        if (this.isImmutableAsset(filePath, ext)) {
          // Hashed assets can be cached indefinitely
          res.setHeader('Cache-Control', `public, max-age=${IMMUTABLE_CACHE_MAX_AGE}, immutable`);
        } else {
          // HTML and other mutable files should always be revalidated
          res.setHeader('Cache-Control', `public, max-age=${MUTABLE_CACHE_MAX_AGE}, must-revalidate`);
        }
      },
    });
  }

  /**
   * SPA fallback middleware - serves index.html for non-asset requests.
   */
  private spaFallback(): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      // Skip non-GET requests
      if (req.method !== 'GET') {
        next();
        return;
      }

      // Skip API routes or WebSocket upgrade requests
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
        next();
        return;
      }

      // Skip if requesting a static asset that doesn't exist
      const ext = extname(req.path).toLowerCase();
      if (STATIC_EXTENSIONS.has(ext)) {
        next();
        return;
      }

      // Serve index.html for SPA routing
      this.serveIndexHtml(res, next);
    };
  }

  // ===========================================================================
  // Private Methods - Utilities
  // ===========================================================================

  /**
   * Determines if an asset should be cached as immutable.
   *
   * Vite generates hashed filenames for production assets,
   * which can be safely cached indefinitely.
   */
  private isImmutableAsset(filePath: string, ext: string): boolean {
    // Only cache JS, CSS, and font files as immutable
    if (!['.js', '.mjs', '.css', '.woff', '.woff2'].includes(ext)) {
      return false;
    }

    // Check for hash pattern in filename (e.g., assets/index-abc123.js)
    const hashPattern = /-[a-f0-9]{8,}\.(js|mjs|css|woff2?)$/;
    return hashPattern.test(filePath);
  }

  /**
   * Serves the index.html file with appropriate headers.
   */
  private serveIndexHtml(res: Response, next: NextFunction): void {
    if (!this.indexHtmlExists()) {
      next();
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${MUTABLE_CACHE_MAX_AGE}, must-revalidate`);
    res.sendFile(this.indexHtmlPath, (error) => {
      if (error) {
        next(error);
      }
    });
  }

  /**
   * Checks if index.html exists in the static directory.
   */
  private indexHtmlExists(): boolean {
    try {
      return existsSync(this.indexHtmlPath) && statSync(this.indexHtmlPath).isFile();
    } catch {
      return false;
    }
  }

  private emit(event: StaticServerEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors to prevent cascade failures
      }
    }
  }
}
