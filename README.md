# Esteban Cloud

Nube personal bidireccional en malla para Windows (y acceso móvil Android/iOS vía Web App PWA dentro del túnel cifrado), con **Métricas globales de red**, **Mensajería P2P completa** y **actualizaciones automáticas desde Tailscale y GitHub Releases**.

Hecho por **Esteban Nicola** · [estebanico.com](https://estebanico.com)

## Características principales

- **App unificada bidireccional (Electron + React/Vite):** cada PC Windows puede actuar a la vez como **Host** (compartir carpetas con lectura o lectura/escritura sobre REST + WebDAV RFC 4918) y como **Cliente** (montar carpetas remotas como unidad `Z:`, `Y:` vía `rclone` + `WinFsp` o explorarlas directo en la app).
- **Túnel cifrado global + LAN:** funciona en casa y fuera de casa mediante **Tailscale (WireGuard)** sin abrir puertos en el router ni necesitar IP fija.
- **Llaves encriptadas portables (`.ecloudkey`):** cifradas con **PBKDF2-SHA256 (310.000 iteraciones) + AES-256-GCM** y par **Ed25519**, listas para guardar en uno o varios pendrives USB con revocación en 1 clic.
- **Kit Pendrive 1-clic:** genera una carpeta lista para llevar a cualquier PC con instalador, lanzadores `.cmd`, scripts PowerShell y llave `.ecloudkey`.
- **Métricas globales de red y alertas de sobrecarga:** panel de toda la malla Tailscale (equipos conectados y capacidad del plan), almacenamiento global en GB/TB, CPU %, RAM %, latencia, **velocidad de disco en vivo + benchmark (MB/s)** y **notificaciones nativas de Windows** cuando una PC está sobrecargada.
- **Mensajería P2P completa entre computadoras:** múltiples chats, crear y eliminar chats, editor de texto enriquecido Markdown con vista previa, envío/arrastre/pegado (`Ctrl+V`) de imágenes con Lightbox, envío y descarga de archivos, eliminación individual de mensajes y adjuntos, y notificaciones de Windows.
- **Actualizador automático dual (GitHub Releases + Tailscale P2P):** comprueba automáticamente la versión más reciente tanto en **GitHub Releases** (`estebanico10/esteban-cloud`) como en tus equipos conectados por Tailscale, descarga con verificación **SHA-256** (siguiendo redirecciones HTTPS) e instala automáticamente cuando no hay unidades montadas en uso.
- **Acceso móvil inmediato (PWA):** servido dentro del túnel con código QR, desbloqueo mediante `.ecloudkey`, streaming con `Range`, descarga, subida y gestión de carpetas.
- **Instalador 1-clic de dependencias:** [scripts/install-dependencies.ps1](./scripts/install-dependencies.ps1) instala Tailscale, `rclone`, `WinFsp`, OpenSSH opcional y regla de Firewall limitada a Tailscale (`100.64.0.0/10`) y redes privadas LAN.

## Desarrollo y compilación

```powershell
npm install
npm test
npm run build
npm start
```

Para compilar el instalador Windows NSIS (`.exe`):

```powershell
npm run dist:win
```

## Publicar una actualización automática en GitHub Releases

Cada vez que subas un nuevo Release a GitHub con el instalador `Esteban-Cloud-Setup-X.Y.Z.exe` y el archivo `SHA256SUMS.txt`, todas las computadoras con Esteban Cloud detectarán, descargarán y verificarán por SHA-256 la actualización de forma automática:

```powershell
npm run dist:win
gh release create v0.2.1 "release/Esteban-Cloud-Setup-0.2.1.exe" "release/SHA256SUMS.txt" --title "Esteban Cloud v0.2.1" --generate-notes
```

## Licencias de dependencias externas sugeridas

- **Tailscale:** BSD-3-Clause (cliente) / Plan Personal gratuito (hasta 100 dispositivos).
- **rclone:** MIT.
- **WinFsp:** GPLv3 / FLOSS.
