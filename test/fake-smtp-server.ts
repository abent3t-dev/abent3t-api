import { createServer, type AddressInfo, type Socket } from 'node:net';

/**
 * J3 (2026-10-01) — SMTP falso para las pruebas del transporte: habla lo
 * mínimo del protocolo (EHLO, MAIL, RCPT, DATA, QUIT) en 127.0.0.1 con un
 * puerto libre y guarda lo que recibe. NO ofrece STARTTLS: un cliente que
 * exige TLS (con usuario) debe fallar sin mandar credenciales.
 */

export interface FakeSmtpMessage {
  from: string;
  to: string[];
  /** Encabezados y cuerpo tal como llegaron en DATA. */
  data: string;
}

export interface FakeSmtpServer {
  port: number;
  messages: FakeSmtpMessage[];
  /** Comandos recibidos (sin el contenido de DATA). */
  commands: string[];
  close(): Promise<void>;
}

const address = (line: string) => /<([^>]*)>/.exec(line)?.[1] ?? '';

export async function startFakeSmtp(
  options: { rejectRecipients?: boolean } = {},
): Promise<FakeSmtpServer> {
  const messages: FakeSmtpMessage[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    const reply = (line: string) => socket.write(`${line}\r\n`);

    let buffer = '';
    let inData = false;
    let current: FakeSmtpMessage = { from: '', to: [], data: '' };

    reply('220 fake.smtp ESMTP listo');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf('\r\n');
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\r\n');

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = { from: '', to: [], data: '' };
            reply('250 2.0.0 Ok: queued as FAKE1');
          } else {
            current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }

        commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          socket.write('250-fake.smtp\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        } else if (verb === 'HELO') {
          reply('250 fake.smtp');
        } else if (verb === 'MAIL') {
          current.from = address(line);
          reply('250 2.1.0 Ok');
        } else if (verb === 'RCPT') {
          if (options.rejectRecipients) {
            reply('550 5.1.1 Destinatario desconocido');
          } else {
            current.to.push(address(line));
            reply('250 2.1.5 Ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 Termina con <CRLF>.<CRLF>');
        } else if (verb === 'RSET' || verb === 'NOOP') {
          reply('250 2.0.0 Ok');
        } else if (verb === 'QUIT') {
          reply('221 2.0.0 Adiós');
          socket.end();
        } else {
          // STARTTLS y AUTH incluidos: este servidor no los tiene
          reply('502 5.5.1 No implementado');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    messages,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
