import { IsOptional, IsUrl, MaxLength } from 'class-validator';

/**
 * Fase §16 — Alternativa al archivo: link externo HTTPS (Google Slides /
 * SharePoint). El endpoint acepta multipart con `file` O este campo.
 */
export class CommitteeVersionLinkDto {
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  external_link?: string;
}
