import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EmailOutboxService } from './email-outbox.service';
import { EmailOutboxQueryDto, EmailPauseDto } from './dto/email-outbox.dto';

/** Quienes ven la bitácora (Compras y RH tienen avisos en la cola). */
const OUTBOX_VIEWERS = ['super_admin', 'lider_procura', 'admin_rh'];

/**
 * J1 (hilo con César, 2026-10-01) — Bitácora de correo para admins: qué se
 * envió, a quién, cuándo y con qué resultado; estado de la cola (pausa,
 * tope, ritmo) para el aviso en la app; y el interruptor "Pausar envíos",
 * solo super_admin.
 */
@Controller('correo')
export class EmailOutboxController {
  constructor(private readonly outbox: EmailOutboxService) {}

  @Roles(...OUTBOX_VIEWERS)
  @Get('estado')
  status() {
    return this.outbox.status();
  }

  @Roles(...OUTBOX_VIEWERS)
  @Get('bitacora')
  list(@Query() query: EmailOutboxQueryDto) {
    return this.outbox.list(query);
  }

  @Roles(...OUTBOX_VIEWERS)
  @Get('bitacora/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.outbox.detail(id);
  }

  @Roles('super_admin')
  @Put('pausa')
  pause(@Body() dto: EmailPauseDto, @CurrentUser() user: { id: string }) {
    return this.outbox.setPaused(dto.paused, user.id, dto.motivo);
  }
}
