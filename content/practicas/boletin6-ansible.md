---
title: "Boletín 6: Despliegue con Ansible"
---

# Boletín 6: Despliegue con Ansible

> **OBJETIVO**
>
> Hasta ahora el pipeline construye, valida y publica una imagen Docker en ghcr, pero nadie la ejecuta en ningún sitio. En esta sesión usarás Ansible para desplegar automáticamente esa imagen sobre una pequeña flota de máquinas y dejarla corriendo.

## 1. Objetivos de la sesión

- **Entender qué es Ansible** y el concepto de configuración e infraestructura como código.
- **Escribir un playbook multi-host** que instale Docker en toda la flota y despliegue la base de datos y la aplicación cada una en su grupo de máquinas.
- **Desplegar sobre varias máquinas** (varios contenedores que harán de servidores destino, agrupados por rol) vía SSH.
- **Disparar el despliegue desde GitHub Actions**, logrando CD.

## 2. Conceptos clave

### 2.1 Qué es Ansible

Ansible es una herramienta de automatización de configuración y despliegue. Describes en archivos YAML el estado deseado de una máquina (qué paquetes, qué servicios, qué contenedores), y Ansible se encarga de que la máquina llegue a ese estado. En lugar de configurar servidores a mano (y olvidar lo que hiciste), tienes el despliegue versionado y reproducible en el repositorio.

### 2.2 Por qué "agentless"

Ansible no necesita instalar nada permanente en la máquina destino. Se conecta por SSH y ejecuta las acciones de forma remota. Solo se necesita tener instalado Ansible en tu máquina (el "controlador") y acceso SSH al servidor.

### 2.3 Vocabulario esencial

| Término | Qué es |
|---|---|
| inventory | Lista de las máquinas que gestionas y cómo conectarte a ellas. |
| group | Subconjunto del inventory con un rol común (p. ej. `app`, `db`), al que se dirigen tareas o plays distintos. |
| playbook | Archivo YAML con la secuencia de tareas a aplicar. |
| task | Una acción concreta (instalar un paquete, arrancar un contenedor…). |
| module | El componente que ejecuta cada tarea (p. ej. el módulo docker_container). |
| role | Un conjunto de tareas, plantillas y variables reutilizable y con estructura fija. |
| collection | Paquete distribuible de módulos y roles (p. ej. community.docker). |

> **CONSEJO**
>
> **Idempotencia**: la propiedad central de Ansible. Ejecutar el mismo playbook varias veces deja la máquina en el mismo estado, sin repetir efectos. Si el contenedor ya está corriendo con la versión correcta, Ansible no hace nada; si no, lo corrige. Se puede relanzar sin miedo.

### 2.4 Nunca despliegues por "latest"

Es el error más común y el más caro. Si el playbook despliega `:latest` no puedes responder a la pregunta *"¿qué versión está corriendo?"*, no puedes reproducir un despliegue pasado y no puedes volver atrás. Además destruye la idempotencia real ya que cada ejecución tiene que ir al registro a comprobar si `latest` cambió. Desplegaremos siempre por un tag que no sea `:latest` (`1.2.0` o `sha-abc1234`).

## 3. Trabajo práctico

### Parte A — Instalar Ansible y sus dependencias

- Instala [Ansible](https://docs.ansible.com/projects/ansible/latest/installation_guide/intro_installation.html#pipx-install) versión 2.16.x. (por ejemplo, con `apt` se puede instalar la 2.16.3 en Ubuntu 24.04):

```bash
ansible --version
```

- Instala la collection que aporta los módulos de Docker.

```bash
ansible-galaxy collection install community.docker:3.7.0
```

- Declara la dependencia en el repositorio para que sea reproducible, en `deploy/requirements.yml`:

```yaml
collections:
  - name: community.docker
    version: "3.7.0"
# se instala con:  ansible-galaxy collection install -r deploy/requirements.yml
```


### Parte B — Preparar la flota de servidores destino

En lugar de pagar servidores en la nube, usarás varios contenedores Linux con SSH que harán de máquinas destino. Así todo el despliegue ocurre en tu portátil, pero el flujo (varios hosts, agrupados por rol) es idéntico al real. En vez de una única máquina, vas a levantar **tres "ordenadores"**: dos para la aplicación (`app1`, `app2`) y uno para la base de datos (`db1`).

- Crea `deploy/servidores/docker-compose.yml` con los tres contenedores, cada uno con SSH habilitado y accesible en un puerto distinto del anfitrión:

```yaml
# deploy/servidores/docker-compose.yml
# Simula tu infraestructura: NO tiene nada que ver con el docker-compose.yml
# de la app (Boletín 3). Esto son las "máquinas" a las que Ansible se conectará por SSH.
services:
  app1:
    image: rastasheep/ubuntu-sshd:18.04   # Ubuntu con sshd ya arrancado
    container_name: app1
    privileged: true            # necesario: dentro correrá su propio Docker
    ports:
      - "2223:22"
      - "8081:8080"   # aquí quedará la API una vez desplegada dentro

  app2:
    image: rastasheep/ubuntu-sshd:18.04
    container_name: app2
    privileged: true
    ports:
      - "2224:22"
      - "8082:8080"

  db1:
    image: rastasheep/ubuntu-sshd:18.04
    container_name: db1
    privileged: true
    ports: [ "2225:22" ]  
```

> **CONSEJO**
>
> El objetivo didáctico es tener varias máquinas Linux a las que Ansible pueda entrar por SSH. Cómo las consigas (contenedores como aquí, VMs con Vagrant o multipass, Raspberry Pis, instancias del free tier de una nube) es secundario; el playbook será el mismo. 

- Levanta la flota y comprueba que puedes entrar por SSH manualmente en cada máquina antes de usar Ansible:

```bash
docker compose -f deploy/servidores/docker-compose.yml up -d

ssh root@localhost -p 2223   # app1 (contraseña: root)
ssh root@localhost -p 2224   # app2
ssh root@localhost -p 2225   # db1
# importante, prueba que el ssh funciona en los tres
```

### Parte C — El inventario

El inventario agrupa las máquinas **por rol**. Crea `deploy/inventory.ini`:

```ini
[app]
app1 ansible_host=localhost ansible_port=2223 ansible_user=root
app2 ansible_host=localhost ansible_port=2224 ansible_user=root

[db]
db1 ansible_host=localhost ansible_port=2225 ansible_user=root

[servidores:children]
app
db

[servidores:vars]
ansible_python_interpreter=/usr/bin/python3
ansible_password=root
ansible_ssh_common_args='-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'
```


- Instala `sshpass` si no lo tienes (para que Ansible pueda enviar la contraseña por SSH):

```bash
sudo apt install -y sshpass
```

- Verifica la conexión con un "ping" de Ansible a toda la flota:

```bash
ansible -i deploy/inventory.ini servidores -m ping
```

Debes ver `pong` desde `app1`, `app2` y `db1`: Ansible ya controla la flota.

### Parte D — El playbook de despliegue

Crea `deploy/deploy.yml` que instala Docker en toda la flota, despliega la base de datos en `db` y, por último, la aplicación en `app` apuntando a la base de datos por el nombre de su host. Tienes que cambiar `ghcr.io/TU_USUARIO/tareas-api` por tu usuario de GitHub y el nombre de la imagen que publicaste en el Boletín 5.

```yaml
- name: Preparar Docker en toda la flota
  hosts: servidores
  tasks:
    - name: Instalar Docker y el SDK de Python
      apt:
        name: [ docker.io, python3-docker ]
        state: present
        update_cache: true

    - name: Arrancar dockerd (los contenedores no tienen systemd)
      shell: |
        nohup dockerd > /var/log/dockerd.log 2>&1 &
        for i in $(seq 1 30); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done
        cat /var/log/dockerd.log
        exit 1
      args:
        creates: /var/run/docker.pid


- name: Desplegar la base de datos
  hosts: db
  tasks:
    - name: Base de datos PostgreSQL
      community.docker.docker_container:
        name: tareas-db
        image: postgres:16
        state: started
        restart_policy: always
        network_mode: host             
        volumes: [ "tareas-db-data:/var/lib/postgresql/data" ]
        env:
          POSTGRES_DB: "{{ db_name }}"
          POSTGRES_USER: "{{ db_user }}"
          POSTGRES_PASSWORD: "{{ db_pass }}"
        healthcheck:
          test: [ "CMD-SHELL", "pg_isready -U {{ db_user }}" ]
          interval: 5s
          retries: 10

- name: Desplegar la API de tareas
  hosts: app
  vars:
    version_app: "1.0.0"                                   # se sobreescribe desde el CI
    imagen: "ghcr.io/TU_USUARIO/tareas-api:{{ version_app }}"
    host_bd: "{{ groups['db'][0] }}"                        # primer host del grupo db

  tasks:
    - name: Login en GHCR
      community.docker.docker_login:
        registry_url: ghcr.io
        username: "{{ ghcr_user }}"
        password: "{{ ghcr_token }}"

    - name: Descargar la imagen de la aplicación
      community.docker.docker_image:
        name: "{{ imagen }}"
        source: pull

    - name: Arrancar el contenedor de la API
      community.docker.docker_container:
        name: tareas-api
        image: "{{ imagen }}"
        state: started
        recreate: false          # idempotencia: no lo toca si ya es esta versión
        restart_policy: always
        network_mode: host       # comparte red con esta máquina: así ve a "{{ host_bd }}" por su nombre
        env:
          SPRING_DATASOURCE_URL: "jdbc:postgresql://{{ host_bd }}:5432/{{ db_name }}"
          SPRING_DATASOURCE_USERNAME: "{{ db_user }}"
          SPRING_DATASOURCE_PASSWORD: "{{ db_pass }}"

    - name: Smoke test — esperar a que la API esté sana
      uri:
        url: "http://localhost:8080/actuator/health"
        status_code: 200
      register: salud
      retries: 20
      delay: 5
      until: salud.json.status is defined and salud.json.status == "UP"
```

> **OJO**
>
> Cada "ordenador" es a su vez un contenedor con su propio Docker dentro (Docker-in-Docker). `network_mode: host` hace que el contenedor de dentro comparta la red de la máquina que lo aloja. De esta forma, el contenedor puede resolver el nombre de otro host del inventario (`db1`) igual que lo resuelve la propia máquina, y su puerto queda expuesto directamente en ella. Sin esto, el contenedor de la API viviría en una red interna aislada del contenedor de la base de datos y jamás la encontraría.

> **OJO**
>
> Las credenciales (`ghcr_token`, `db_name`, `db_user`, `db_pass`, ...) **nunca** se escriben en el playbook ni se pasan por `--extra-vars` en la línea de comandos (quedan en el historial de tu shell y en la tabla de procesos). Usa Ansible Vault en local y secrets desde las pipelines. 


### Parte E — Proteger las credenciales con Ansible Vault

```yaml
# Crea el archivo cifrado (te pedirá una contraseña maestra)
ansible-vault create deploy/group_vars/servidores/vault.yml

# Contenido (queda cifrado en el repositorio):
ghcr_user: TU_USUARIO
ghcr_token: ghp_xxxxxxxxxxxx
db_name: tareas
db_user: app
db_pass: una_clave_larga

# Para editarlo después:
ansible-vault edit deploy/group_vars/servidores/vault.yml
```

- Comprueba con `cat` que el archivo versionado es ilegible.

### Parte F — Ejecutar el despliegue a mano

- Lanza el playbook contra toda la flota:

```bash
ansible-playbook -i deploy/inventory.ini deploy/deploy.yml \
  --ask-vault-pass --extra-vars "version_app=1.0.0"
```

- Comprueba que la aplicación quedó corriendo en **las dos réplicas**, ambas hablando con la misma base de datos en `db1`:

```bash
curl http://localhost:8081/api/tasks   # app1
curl http://localhost:8082/api/tasks   # app2
# las dos deben responder la misma API, desplegada por Ansible
```

- Vuelve a ejecutar el mismo playbook y observa la idempotencia. Ansible informará de `changed=0` en las tres máquinas (todo ya está en el estado deseado). Guarda la salida de las dos ejecuciones.

- **Despliega una versión nueva**: publica un `v1.1.0` y relanza con `--extra-vars "version_app=1.1.0"`. Comprueba que ahora sí hay cambios en `app1` y `app2`, y que ambas responden con lo nuevo.

- **Vuelve atrás**: relanza con `version_app=1.0.0` y verifica que el rollback funciona en menos de un minuto en las dos réplicas. Esto solo es posible porque los tags son inmutables.

### Parte G — Disparar el despliegue desde GitHub Actions (cierre CD)


Ahora automatizas el despliegue. Cada vez que publiques una versión (`vX.Y.Z`), GitHub Actions construirá la imagen y, a continuación, ejecutará Ansible desde tu propio ordenador. Como las "máquinas" de la flota son contenedores que viven en tu portátil (`localhost:2223`...), un runner de GitHub en la nube no podría llegar a ellas y necesitas un **runner autoalojado** (*self-hosted*), es decir, un programa que instalas en tu máquina y que recibe trabajos de GitHub.

#### G.1 — Registrar tu ordenador como runner

- En tu repositorio: **Settings → Actions → Runners → New self-hosted runner**. Elige Linux/x64 (en WSL2 también vale) y ejecuta en tu máquina los comandos que te muestra GitHub. Tienen esta forma:

```bash
mkdir actions-runner && cd actions-runner
# descarga y descompresión: copia los comandos exactos de la página de GitHub
./config.sh --url https://github.com/TU_USUARIO/TU_REPO --token <TOKEN_QUE_TE_DA_GITHUB>
./run.sh        # déjalo en marcha: mientras no esté corriendo, el despliegue se queda esperando
```

- `config.sh` te hará varias preguntas. Pulsa **Enter** en todas para aceptar los valores por defecto:
  - *Runner group*: `Default` (los grupos solo se usan en organizaciones).
  - *Nombre del runner*: el nombre de tu máquina; es solo una etiqueta para reconocerlo en GitHub.
  - *Etiquetas adicionales* (*labels*): ninguna. El runner ya trae `self-hosted`, `Linux` y `X64`, y tu job pedirá `self-hosted`.
  - *Carpeta de trabajo* (`_work`), si te la pregunta: la de por defecto.
- Comprueba que en **Settings → Actions → Runners** aparece como **Idle**.
- El runner ejecuta los comandos con tu usuario, así que necesita lo mismo que usaste a mano en la Parte F: `ansible`, `sshpass` y la flota levantada.


#### G.2 — Entorno protegido y secreto del Vault

- **Settings → Environments → New environment**, llámalo `produccion` y añade al menos un **Required reviewer**. Cualquier job que declare `environment: produccion` se quedará esperando esa aprobación antes de arrancar.
- Dentro de ese entorno, añade un secret `VAULT_PASS` con la contraseña maestra de tu Ansible Vault. 

#### G.3 — Ampliar el `release.yml`

Amplía el `.github/workflows/release.yml` que escribiste en el [Boletín 5](boletin5-cd-github-actions.html). Mantén tal cual el job `publish`, salvo la línea `outputs`, que es nueva y permite al siguiente job saber qué versión se publicó, y añade debajo el job `deploy`. El fichero completo quedaría a algo similar a esto:

```yaml
name: Release

on:
  push:
    branches: [ main ]
    tags: [ "v*.*.*" ]

permissions:
  contents: read
  packages: write

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    outputs:
      version: ${{ steps.meta.outputs.version }}   # NUEVO: 1.0.0 cuando el tag es v1.0.0
    steps:
      - uses: actions/checkout@v4

      - name: Login en GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Metadatos (tags)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=sha,prefix=sha-
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Construir y publicar
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}

  # NUEVO: todo lo que sigue es lo que añades en esta parte
  deploy:
    needs: publish                                  # solo si la imagen se publicó bien
    # solo al publicar una versión (tag vX.Y.Z), no en cada push a main
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: self-hosted                            # tu ordenador
    environment: produccion                         # se detiene aquí hasta que un reviewer lo apruebe
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: Instalar la collection de Ansible
        run: ansible-galaxy collection install -r deploy/requirements.yml

      - name: Desplegar con Ansible
        env:
          VAULT_PASS: ${{ secrets.VAULT_PASS }}
          VERSION: ${{ needs.publish.outputs.version }}
        run: |
          VAULT_FILE="$(mktemp)"
          trap 'rm -f "$VAULT_FILE"' EXIT
          printf '%s' "$VAULT_PASS" > "$VAULT_FILE"
          ansible-playbook -i deploy/inventory.ini deploy/deploy.yml \
            --vault-password-file "$VAULT_FILE" \
            --extra-vars "version_app=$VERSION"
```

- `needs: publish` garantiza que no se despliega una imagen que no existe, y la condición `startsWith(github.ref, 'refs/tags/v')` evita que cada push a `main` dispare un despliegue.
- La versión desplegada es el tag semántico de la imagen (`1.0.0`), el mismo que usaste a mano en la Parte F. Trazabilidad completa: de la aplicación corriendo a la etiqueta Git que la produjo.
- El fichero temporal del Vault se borra siempre al terminar (`trap`), también si el despliegue falla.

#### G.4 — Pruébalo de extremo a extremo

- Con la flota levantada y el runner en marcha, publica una versión nueva.
- En la pestaña Actions verás `publish` ejecutarse en GitHub, y después `deploy` en pausa esperando aprobación. Apruébalo y comprueba en tu terminal que el runner recibe el trabajo.
- Verifica que `curl http://localhost:8081/api/tasks` y `curl http://localhost:8082/api/tasks` responden con la nueva versión.
- Dibuja un diagrama de la arquitectura completa que has montado en este boletín. Debe dejar claro **dónde ocurre cada cosa**, es decir, en qué máquina física o virtual y en qué contenedor se ejecuta cada pieza. Incluye como mínimo:
  - **GitHub (la nube):** el repositorio, GitHub Actions, el registro de imágenes (GHCR), el entorno `produccion` con su aprobación manual y los secrets.
  - **Tu ordenador (el anfitrión físico):** el runner autoalojado, Ansible (el controlador) y el Docker que ejecuta la flota.
  - **Los contenedores que hacen de "máquinas"** (`app1`, `app2`, `db1`): qué corre dentro de cada uno (su propio Docker y, en su interior, la API o PostgreSQL) y qué puertos se exponen hacia tu ordenador.
  - **Las conexiones entre piezas:** con una flecha para cada una, indicando el protocolo (HTTPS, SSH...) y quién inicia la conexión.
- Sobre ese mismo diagrama, numera los pasos de lo que ocurre **desde que haces `git push` de un tag `vX.Y.Z` hasta que la aplicación queda corriendo en las dos réplicas**. 

> **CONSEJO**
>
> En una empresa el runner autoalojado no sería tu portátil, sino una máquina dedicada dentro de la red que puede llegar a los servidores.
