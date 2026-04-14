import { Controller, Post, Get } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { RemindersService } from './reminders.service';
import { EmailService } from '../email/email.service';

@Controller('reminders')
export class RemindersController {
  constructor(
    private readonly remindersService: RemindersService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Ejecutar verificación de recordatorios manualmente
   * Solo para admin_rh y super_admin
   */
  @Post('check')
  @Roles('super_admin', 'admin_rh')
  async runManualCheck() {
    const result = await this.remindersService.runManualCheck();
    return {
      message: 'Verificación de recordatorios ejecutada',
      ...result,
    };
  }

  /**
   * Obtener estado del servicio de email
   */
  @Get('email-status')
  @Roles('super_admin', 'admin_rh')
  getEmailStatus() {
    const providerInfo = this.emailService.getProviderInfo();
    return {
      provider: providerInfo.name,
      configured: providerInfo.configured,
      mode: providerInfo.configured ? 'producción' : 'simulación',
      note: !providerInfo.configured
        ? 'Configure AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET para habilitar envío real de correos'
        : undefined,
    };
  }
}
