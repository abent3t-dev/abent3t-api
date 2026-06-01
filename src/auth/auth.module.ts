import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthService } from './services/jwt-auth.service';
import { LocalAuthService } from './services/local-auth.service';
import { OIDCAuthService } from './services/oidc-auth.service';
import { AuthEventsService } from './services/auth-events.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

/**
 * AuthModule (@Global): expone los servicios de autenticación al resto de
 * la app — particularmente `JwtAuthService` que también consume el guard
 * global `JwtAuthGuard` y el `SocketGateway` para validar tokens en el
 * handshake.
 *
 * `JwtModule.registerAsync` permite leer `JWT_SECRET` de `ConfigModule` (que
 * ya es global).
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret:
          process.env.JWT_SECRET ||
          'dev-only-fallback-please-set-jwt-secret-in-env',
        // El `expiresIn` por defecto se pasa por llamada — ver jwt-auth.service.ts.
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthEventsService,
    JwtAuthService,
    LocalAuthService,
    OIDCAuthService,
    JwtAuthGuard,
  ],
  exports: [
    AuthService,
    AuthEventsService,
    JwtAuthService,
    LocalAuthService,
    OIDCAuthService,
    JwtAuthGuard,
  ],
})
export class AuthModule {}
