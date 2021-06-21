const { forwardTo } = require('prisma-binding');
const { hasPermissions } = require('../utils');

const Query = {
  items: forwardTo('db'),
  categories: forwardTo('db'),
  subcategories: forwardTo('db'),
  item: forwardTo('db'),
  me(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      return null;
    }
    return ctx.db.query.user(
      {
        where: { id: ctx.request.userId }
      },
      info
    );
  },
  async users(parent, args, ctx, info) {
    // 1. Check if they are logged in
    if (!ctx.request.userId) {
      throw new Error('You have to be logged in');
    }
    // hasPermissions(ctx.request.user, ['ADMIN']);
    if (!ctx.request.user.permissions.includes('ADMIN'))
      throw new Error('You have to be an administrator to access this data.');
    // 3. if thats the case, look for all the users
    return ctx.db.query.users({}, info);
  },
  async order(parent, args, ctx, info) {
    // 1. Make sure they are logged in
    if (!ctx.request.userId) {
      throw new Error('You have to be logged in to do that');
    }
    // 2. Query the current order
    const order = await ctx.db.query.order(
      {
        where: { id: args.id }
      },
      info
    );
    // 3. permissions
    const ownsOrder = order.user.id === ctx.request.userId;
    const isAdmin = ctx.request.user.permissions.includes('ADMIN');

    if (!ownsOrder && !isAdmin)
      throw new Error('You do not have access to that resource');
    return order;
  },
  async orders(parent, args, ctx, info) {
    const { userId } = ctx.request;
    if (!ctx.request.userId) {
      throw new Error('You have to be logged in');
    }
    return ctx.db.query.orders(
      {
        where: {
          user: {
            id: userId
          }
        }
      },
      info
    );
  },
  async adminOrders(parent, args, ctx, info) {
    const { userId } = ctx.request;
    if (!userId)
      throw new Error('You have to be logged in to access this data.');

    if (!ctx.request.user.permissions.includes('ADMIN'))
      throw new Error('You have to be an administrator to access this data.');

    return ctx.db.query.orders({ orderBy: 'createdAt_DESC' }, info);
  }
};

module.exports = Query;
