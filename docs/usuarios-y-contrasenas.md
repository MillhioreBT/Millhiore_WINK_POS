# Usuarios y contraseñas

Cada persona entra con su usuario y su contraseña. Lo que puede hacer depende de su rol: dueño, administrador, cajero o almacenista. Los usuarios se crean y editan en **Ajustes → Usuarios**.

## Cambiar mi contraseña

Con el ícono de la llave en la barra superior (en el celular: menú ☰ → «Cambiar mi contraseña»).

- Pide la **contraseña actual**. Así, quien encuentre tu sesión abierta en la caja no puede quedarse con tu cuenta.
- Por defecto **cierra tu sesión en los demás equipos** (celulares, otras PC). La del equipo desde el que la cambias sigue abierta.
- Tras 5 intentos con la actual equivocada, el cambio se bloquea 15 minutos.

## El dueño restablece la contraseña de otra persona

En **Ajustes → Usuarios**, botón «Contraseña» de esa persona:

1. El sistema propone una **contraseña temporal** fácil de dictar (p. ej. `7hz9-5f8t-45c4`). Se puede cambiar.
2. Al restablecerla se **cierran todas las sesiones** de esa persona.
3. Al entrar con la temporal, solo ve la pantalla «Elige tu contraseña»: debe poner una propia antes de usar el sistema. El servidor también rechaza cualquier otra acción mientras tanto. Así el dueño nunca conoce la contraseña definitiva.

Protecciones:

- Tu propia contraseña no se restablece desde aquí: se cambia con la llave.
- A un dueño solo lo modifica otro dueño.
- El negocio nunca se queda sin un dueño activo: no se puede desactivar ni cambiar de rol al último.
- Desactivar a alguien cierra sus sesiones al instante.

## Si nadie recuerda la contraseña del dueño

Como es un sistema local, no hay recuperación por correo. Se recupera **desde la PC donde corre el servidor**: quien tiene esa PC ya tiene los datos, así que esto no abre ningún hueco nuevo. El servidor puede seguir encendido mientras lo haces.

Con `bun run start`, desde la carpeta del proyecto:

```sh
bun run reset-password            # lista los usuarios
bun run reset-password duena      # da una contraseña temporal a «duena»
```

Con la app de escritorio, desde la consola (cmd o PowerShell):

```sh
"%LOCALAPPDATA%\Millhiore WINK POS\millhiore-server.exe" reset-password duena
```

`%LOCALAPPDATA%\Millhiore WINK POS` es la carpeta de instalación por defecto. El comando encuentra los datos solo: `./data` o los de la app de escritorio. Si están en otro lugar, agrega `--data <carpeta>`.

Muestra una contraseña temporal, cierra las sesiones de ese usuario y lo reactiva si estaba inactivo. Al entrar con ella hay que elegir una propia, igual que en el caso anterior.

## Reglas y seguridad

- Mínimo 8 caracteres. No se aceptan las muy comunes (`12345678`, `contraseña`…) ni las que contienen el usuario, el nombre o el nombre del negocio. La web avisa mientras escribes y el servidor lo vuelve a comprobar.
- Las contraseñas se guardan cifradas con **Argon2id**: nadie puede leerlas, ni siquiera el dueño o quien tenga la base de datos.
- El inicio de sesión limita los intentos: 5 por minuto desde cada equipo.
- Cada cambio, restablecimiento o recuperación queda en la **auditoría**: quién, a quién y cuándo. Nunca la contraseña.

