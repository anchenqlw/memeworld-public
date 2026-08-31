# Me&Me · 我&猫

Me&Me 是一个由个人 AI Agent 驱动的猫猫旅行世界。本仓库包含 Web、服务端、测试、运行模板与世界数据的源码快照。

公开基线：私有主仓 `origin/main` 的 `46ad520abb0af8c5fe6ccf529318803a15ba174d`。

## 源码范围

- `apps/web/`：React + Vite Web 客户端与静态资产
- `apps/server/`：Fastify 服务端、数据库 schema/migration、后台 worker 与测试
- `templates/`：小猫 Agent 与 QCA Forward 运行模板
- `tasks/cat/daily-travel.yaml`：产品运行时的小猫旅行任务
- `world/`：世界图志、基因库与产品内编年史
- `Dockerfile.server`、`docker-compose.yml`：本地可运行的容器入口

本仓库不包含私有仓的 Git 历史、CI/CD 与自进化流水线、开发决策、backlog、运行账本、内部任务、基础设施配置、用户数据或凭据。

## 本地运行

需要 Node.js 22 与 npm。

```bash
cp .env.example .env
npm ci
npm run dev
```

默认使用本地 SQLite、内存态 Redis、mock 登录和 mock QCA。Web 默认运行在 `http://localhost:5173`，API 默认运行在 `http://localhost:3001`。

```bash
npm test
npm run build
```

也可以使用 Docker Compose：

```bash
docker compose up --build
```

## 安全说明

不要提交真实的 PAT、Cookie、OAuth secret、数据库连接串、对象存储密钥或内部 API key。生产环境必须通过部署平台注入独立凭据。

## License

本项目采用 Apache License 2.0，详见 [LICENSE](LICENSE)。
