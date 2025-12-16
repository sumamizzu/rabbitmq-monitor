# RabbitMQ Monitor CLI

Monitor RabbitMQ su terminale

## 🚀 Setup Rapido

```bash
# 1. Entra nella cartella
cd rabbitmq-monitor-cli

# 2. Installa dipendenze
npm install

# 3. Configura
cp .env.example .env
# Modifica .env se necessario

# 4. Avvia (con tunnel SSH attivo se server remoto)
npm start
```

**Terminale 1** - Tunnel SSH:
```bash
ssh -N -L 15672:localhost:15672 -L 5672:localhost:5672 utente@host
```

**Terminale 2** - Monitor CLI:
```bash
cd rabbitmq-monitor-cli
npm start
```

## 🔧 Troubleshooting

Se non si connette:
- Verifica che il tunnel SSH sia attivo
- Controlla credenziali in `.env`
- Testa manualmente: `curl http://localhost:15672/api/overview -u guest:guest`

## 📝 Note

- I messaggi vengono intercettati **read-only** (non influenzano il flusso)

