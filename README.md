# App de agenda para barbería

Aplicación web para que una barbería reciba reservas en línea de sus clientes
y el barbero controle todo desde un panel privado.

## Qué incluye

- **Página de reservas** (pública, se comparte por link): el cliente elige el
  servicio (corte, barba, corte + barba, etc.), el día, la hora disponible y
  deja su nombre y teléfono. Al final recibe un "ticket" con un número de
  reserva. Puede volver más tarde a la misma página, abrir "Mis reservas" y
  cancelar si lo necesita (esto funciona por navegador/dispositivo, sin
  necesidad de crear una cuenta).
- **Panel del barbero** (protegido con contraseña, pestaña "Panel del
  barbero"): agenda de hoy, próximas citas de los siguientes 14 días, marcar
  citas como atendidas o cancelarlas, administrar servicios (nombre,
  duración, precio), configurar el horario semanal del local (día por día,
  con opción de marcarlo cerrado) y ajustes generales (nombre del negocio,
  nombre del barbero, minutos mínimos de anticipación para reservar, y
  cambio de contraseña).
- Los horarios que se ofrecen a los clientes se calculan solos a partir del
  horario configurado y las citas ya existentes, así que nunca se pueden
  reservar dos citas encimadas.

No envía correos ni WhatsApp automáticos: el barbero ve todo en tiempo real
en su panel. Es la opción más simple para empezar; si más adelante quieres
agregar avisos automáticos, es una extensión que se le puede sumar a este
mismo proyecto.

## Cómo está construida

Un servidor Node.js (Express) con una base de datos SQLite local (un solo
archivo, sin necesidad de contratar una base de datos aparte) y una página
web sencilla en HTML/CSS/JavaScript (sin frameworks pesados, para que sea
fácil de mantener). Todo el proyecto es tuyo: no depende de ninguna cuenta
de Anthropic/Claude ni de servicios de pago para funcionar.

```
barberia-app/
  server.js              punto de entrada del servidor
  src/
    db.js                conexión a SQLite, tablas y datos de ejemplo iniciales
    auth.js               sesiones del panel (JWT)
    availability.js       calculo de horarios disponibles
    routes/
      public.js           endpoints publicos (servicios, horario, reservas)
      auth-routes.js       login del panel
      admin.js             endpoints protegidos del panel
  public/
    index.html
    css/styles.css
    js/app.js              toda la interfaz (reservas + panel)
  data/                    aqui vive el archivo barberia.db (se crea solo)
  .env.example             plantilla de variables de entorno
```

## Uso en tu computador (para probarla)

Requisitos: tener instalado [Node.js](https://nodejs.org) 18 o superior.

```bash
cd barberia-app
npm install
cp .env.example .env
npm start
```

Abre `http://localhost:3000` en el navegador. La pestaña **Reservar** es lo
que verían los clientes; la pestaña **Panel del barbero** pide una
contraseña — por defecto es `cambiame123` (o la que hayas puesto en
`ADMIN_INITIAL_PASSWORD` dentro de tu `.env`, solo aplica la primera vez que
arranca).

**Apenas entres al panel por primera vez, ve a Ajustes y cambia la
contraseña** desde ahí (pide la contraseña actual y la nueva).

## Primeros pasos dentro del panel

1. **Ajustes**: pon el nombre real del negocio y del barbero.
2. **Servicios**: edita, borra o agrega los servicios con su duración y
   precio (ya viene con 5 servicios típicos de ejemplo para que veas cómo
   funciona).
3. **Horario**: define el horario real de atención de cada día, o marca
   "Cerrado" en los días que no atiendes.
4. Comparte el link de la aplicación con tus clientes (por WhatsApp, redes
   sociales, o un botón en tu perfil) para que empiecen a reservar.

## Cómo ponerla en línea (para que los clientes reales puedan entrar)

Como la base de datos es un archivo (SQLite), la app necesita correr en un
servidor con **disco persistente** — es decir, uno que no borre los
archivos entre reinicios. Esto descarta los servicios puramente
"serverless" de un solo uso, pero funciona bien en:

- Un VPS económico (por ejemplo Hetzner, DigitalOcean, etc.): se sube el
  proyecto, se corre `npm install --production` y `npm start` (idealmente
  detrás de `pm2` para que se reinicie solo, y de un proxy como `nginx` con
  certificado HTTPS gratis vía Let's Encrypt/Certbot).
- Una plataforma de despliegue que ofrezca un volumen o disco persistente
  (por ejemplo Railway o Render, entre otras) — al desplegar, monta un
  volumen en la carpeta `data/` para que la base de datos no se pierda en
  cada actualización, y configura ahí las variables de entorno del archivo
  `.env.example` (sobre todo `JWT_SECRET` con un valor propio y largo, y
  `TZ` con la zona horaria de la barbería). Como las condiciones y precios
  de estas plataformas cambian con el tiempo, conviene revisar su
  documentación actual antes de elegir una.

Antes de publicarla de verdad:

- Cambia `JWT_SECRET` en el `.env` por una cadena larga y aleatoria propia
  (no dejes la de ejemplo).
- Cambia la contraseña del panel desde Ajustes.
- Sirve la app por HTTPS (la mayoría de plataformas de despliegue lo hacen
  automáticamente; en un VPS propio, con Certbot es gratis).
- Haz copias de seguridad de `data/barberia.db` de vez en cuando (es un solo
  archivo, se puede copiar sin más).

## Limitaciones actuales / ideas para más adelante

- Pensada para **un solo barbero/local**. Para varias sedes o varios
  barberos con agendas separadas habría que ampliar el modelo de datos.
- No envía recordatorios por correo o WhatsApp — el barbero revisa el panel.
  Se puede agregar más adelante (por ejemplo con un correo diario a las
  7 a.m. con la agenda del día).
- No cobra ni pide depósito en línea; solo agenda el turno.
- La cancelación del cliente funciona por navegador (queda guardada ahí su
  lista de reservas); si borra los datos del navegador o cambia de
  dispositivo, no vería sus reservas anteriores en "Mis reservas" — pero el
  barbero sí las ve todas desde el panel en cualquier momento.
