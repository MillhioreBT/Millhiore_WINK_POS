# Política de seguridad

Millhiore WINK POS maneja dinero, existencias y contraseñas de comercios reales. Tomamos en serio los reportes de seguridad y agradecemos que los hagas de forma responsable.

## Cómo reportar una vulnerabilidad

**No abras un issue público ni lo publiques en redes antes de que esté corregida.**

Usa el reporte privado de GitHub: pestaña **Security → Report a vulnerability** de este repositorio. Así la conversación queda entre tú y quienes mantienen el proyecto.

Incluye, si puedes:

- qué encontraste y qué impacto tiene (por ejemplo: ver o cambiar datos sin permiso, saltarse el inicio de sesión, alterar un saldo);
- los pasos para reproducirlo, la versión y el sistema operativo;
- una prueba de concepto mínima, sin datos reales de ningún negocio.

## Qué esperar

| | |
|---|---|
| Acuse de recibo | en pocos días |
| Evaluación y plan | en las dos semanas siguientes |
| Corrección | según la gravedad; lo crítico primero |
| Reconocimiento | te mencionamos en las notas de la versión, si lo deseas |

Es un proyecto comunitario sin equipo de guardia: los plazos son un compromiso de buena fe, no un contrato.

## Qué versiones reciben correcciones

El proyecto está en desarrollo y todavía no tiene versiones estables. Las correcciones de seguridad se hacen sobre la rama `main` y sobre la última versión publicada.

## Dentro del alcance

- El servidor (`apps/server`): autenticación, sesiones, permisos, API, respaldos y restauración.
- La web y la app de escritorio (`apps/web`, `apps/desktop`).
- Los motores de contabilización y de cálculo de dinero, impuestos y tasas.
- Los instaladores y los archivos de configuración que publica el proyecto.

## Fuera del alcance

- Ataques que exigen acceso físico o administrativo ya concedido a la PC donde corre el servidor: quien tiene esa PC tiene los datos, por diseño. Por eso la recuperación de la contraseña del dueño se hace desde ahí.
- Fallos de dependencias de terceros ya reportados a su proyecto (avísanos si afectan a Millhiore WINK POS).
- Denegación de servicio por volumen en una red local abierta, o la falta de HTTPS en la red local (documentado en [PLAN.md](PLAN.md#https-en-la-red-local)).
- Ingeniería social contra quienes mantienen el proyecto o contra los comercios que lo usan.

## Para quienes lo instalan

- Mantén la PC de la caja actualizada, con contraseña y con el firewall activo. Permite el puerto del servidor solo en redes **privadas**.
- No abras puertos del router hacia el servidor. Para acceso remoto usa Tailscale o Cloudflare Tunnel.
- Haz respaldos y guarda una copia fuera de la PC. Los respaldos contienen todos los datos del negocio: trátalos como información sensible.
- Cada persona con su propio usuario, y cierra las sesiones que ya no uses (menú de usuario → Sesiones).

## Buenas prácticas del proyecto

- Contraseñas y PIN con Argon2id; límite de intentos de inicio de sesión y de PIN.
- Permisos verificados siempre en el servidor.
- Bitácora de toda acción sensible, sin guardar nunca contraseñas.
- Sin telemetría por defecto.
