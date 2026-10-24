# Maratón de preguntas

Juego de preguntas de cultura general con cartas de kilómetros (1 km común, 2 km media, 3 km escasa).

## Una sola pantalla
Abre `index.html` con doble clic. Modos: por turnos o carrera de velocidad, con o sin presentador.

## En red (cada quien con su celular, sin presentador)
1. En la computadora que hará de servidor: doble clic en `iniciar.bat` (o `node server.js`). Requiere Node.js.
2. La ventana muestra las direcciones, por ejemplo `http://192.168.1.20:3000/online.html`.
3. Todos (celulares y computadora) deben estar en el mismo WiFi. Abren esa dirección.
4. Una persona crea la sala; los demás escriben el código de 4 letras. El anfitrión elige modo y cartas y pulsa "Comenzar".

## Tablero general (para proyectar)
Con el servidor abierto, en la misma computadora abre `http://localhost:3000/board.html` y proyéctalo.
Se conecta solo a la sala abierta (si hay varias, te deja elegir). Muestra el código y la dirección para unirse, el marcador de todos
(hasta 25), la pregunta, el desempate y el podio final. No es un jugador y solo funciona en la computadora del servidor:
desde los celulares esa dirección no responde. Si abres la sala desde `localhost`, también aparece el enlace "📺 Abrir tablero general".

Reglas del modo en red:
- Al aparecer cada pregunta, las respuestas quedan bloqueadas 5 segundos para que todos la lean.
- Tras contestar, la siguiente pregunta llega sola a los 5 segundos.
- Carrera: todos tocan la respuesta a la vez. Gana la carta quien acierte primero; quien falla queda fuera de esa pregunta.
- Si dos o más aciertan casi al mismo tiempo (margen de 0.8 s), se desempata con piedra, papel o tijera.
- Si el anfitrión sale de la sala (o pierde la conexión más de 15 s), la partida termina para todos.
- Hasta 25 participantes por sala. Con muchos, el mazo crece solo (6 cartas por jugador, hasta 200) y el celular muestra un marcador resumido.
- Los tiempos se cambian al inicio de `server.js` (LOCK_MS, REVEAL_MS, TIE_MS…).

Si la computadora tiene varias redes (WiFi, VPN, adaptadores virtuales), el servidor pone primero la del WiFi/red local.
Si aun así sale otra, fíjala al abrir: `set MARATHON_IP=192.168.0.45` y luego `node server.js`.

Si los celulares no conectan, permite a Node.js en el Firewall de Windows (redes privadas).

## Redes lentas o inestables

El modo en red tolera conexiones malas:

- Al tocar una respuesta se marca al instante y se reintenta sola si la red falla (no se pierde ni se duplica).
- Los botones no se reconstruyen con cada actualización, así que no se "mueven" mientras los tocas.
- Si el celular pierde la señal, se reconecta solo y recupera el estado actual (también al volver a la app).
- El anfitrión tiene 90 s para volver antes de que se cierre la sala (`HOST_GRACE_MS` lo cambia, en milisegundos). En la sala de espera, un jugador sin conexión sale de la lista a los 60 s.
- Consejo: en los celulares desactiva el bloqueo automático de pantalla durante la partida.

## Preguntas sin repetir
Las preguntas salen en orden aleatorio y ninguna se repite hasta agotar todo el banco; después se vuelve a barajar.
En red, el servidor guarda lo ya preguntado en `vistas.json` (bórralo para empezar de cero). En una sola pantalla se recuerda en el navegador.

## Agregar preguntas
Edita `questions.js` (una línea por pregunta). Reinicia el servidor para que las tome.
