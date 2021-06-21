const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const { transport, makeEmail } = require('../mail');
const stripe = require('../stripe');

const Mutation = {
  async createItem(parent, args, ctx, info) {
    const { userId } = ctx.request;
    if (!userId) throw new Error('You have to be logged in to do that!');
    const { user } = ctx.request;
    const isAdmin = user.permissions.includes('ADMIN');
    if (!isAdmin) throw new Error('You have to be an admin to do that!');
    const item = await ctx.db.mutation.createItem(
      {
        data: {
          ...args,
          category: { connect: { id: args.category } },
          subcategory: { connect: { id: args.subcategory } }
        }
      },
      info
    );
    return item;
  },
  async updateItem(parent, args, ctx, info) {
    const { userId } = ctx.request;
    if (!userId) throw new Error('You have to be logged in to do that!');
    const { user } = ctx.request;
    const isAdmin = user.permissions.includes('ADMIN');
    if (!isAdmin) throw new Error('You have to be an admin to do that!');
    // 1. Скопировать обновления
    const updates = { ...args };
    // 2. Убрать ид из обновлений
    delete updates.id;
    // 3. Обновляем
    return ctx.db.mutation.updateItem(
      {
        data: updates,
        where: {
          id: args.id
        }
      },
      info
    );
  },
  async deleteItem(parent, args, ctx, info) {
    const where = { id: args.id };
    const { userId } = ctx.request;
    if (!userId) throw new Error('You have to be logged in to do that');
    // 1. Найти айтем
    const item = await ctx.db.query.item({ where }, '{ id title }');
    // 2. Проверка прав
    const { user } = ctx.request;
    const isAdmin = user.permissions.includes('ADMIN');
    // 3. Удалить
    if (!isAdmin) throw new Error('You have to be an admin to do that');
    return ctx.db.mutation.deleteItem({ where }, info);
  },

  async signup(parent, args, ctx, info) {
    args.email = args.email.toLowerCase();
    if (args.password !== args.confirmPassword)
      throw new Error('Your passwords do not match!');
    delete args.confirmPassword;
    // Зашифровать пароль
    const password = await bcrypt.hash(args.password, 10);
    const user = await ctx.db.mutation.createUser(
      {
        data: {
          ...args,
          password,
          permissions: { set: ['USER'] }
        }
      },
      info
    );
    // JWT
    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // cookie
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 364 // 1 год
    });
    return user;
  },

  async signin(parent, { email, password }, ctx, info) {
    const user = await ctx.db.query.user({ where: { email } });
    if (!user) {
      throw new Error(`No user with email ${email}`);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      throw new Error('Invalid Password');
    }

    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 364
    });
    return user;
  },

  signout(parent, args, ctx, info) {
    ctx.response.clearCookie('token');
    return { message: 'Goodbye' };
  },

  async requestReset(parent, args, ctx, info) {
    // 1. Проверить, есть ли такой юзер
    const user = await ctx.db.query.user({ where: { email: args.email } });
    if (!user) {
      throw new Error(`No such user`);
    }
    // 2. Послать ресет токен
    const resetToken = (await promisify(randomBytes)(20)).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 час
    const res = await ctx.db.mutation.updateUser({
      where: { email: args.email },
      data: { resetToken, resetTokenExpiry }
    });
    // 3. Скинуть токен им на почту
    const mailRes = await transport.sendMail({
      from: 'goudace@goudace.com',
      to: user.email,
      subject: 'Password reset request',
      html: makeEmail(
        `Your password reset link: \n\n <a href="${
          process.env.FRONTEND_URL
        }/reset?resetToken=${resetToken}">Click me!</a>`
      )
    });
    return { message: 'Thanks!' };
  },

  async resetPassword(parent, args, ctx, info) {
    // 1. Совпадают ли переданные серверу пароли?
    if (args.password !== args.confirmPassword)
      throw new Error('Passwords do not match');
    // 2. Токен ?
    if (!args.resetToken)
      throw new Error('No reset token was provided with request.');
    // 3. Токен еще действует ?
    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000
      }
    });
    if (!user) {
      throw new Error('Token is invalid or expired');
    }
    // 4. Хэшнуть новый пароль
    const password = await bcrypt.hash(args.password, 10);
    // 5. Сохранить пароль и сбросить старый токен
    const updatedUser = await ctx.db.mutation.updateUser({
      where: { email: user.email },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null
      }
    });
    // 6. Сгенерировать токен
    const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
    // 7. Сунуть токен пользователю
    ctx.response.cookie('token', token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365 // 1 год
    });
    // 8. Вернуть юзера
    return updatedUser;
  },
  async addToCart(parent, args, ctx, info) {
    const { userId } = ctx.request;
    if (!userId) {
      throw new Error('You must be signed in');
    }
    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: userId },
        item: { id: args.id }
      }
    });
    // Если айтем уже в корзине
    if (existingCartItem) {
      return ctx.db.mutation.updateCartItem(
        {
          where: { id: existingCartItem.id },
          data: { quantity: existingCartItem.quantity + 1 }
        },
        info
      );
    }
    return ctx.db.mutation.createCartItem(
      {
        data: {
          user: {
            connect: { id: userId }
          },
          item: {
            connect: { id: args.id }
          }
        }
      },
      info
    );
  },

  async removeFromCart(parent, args, ctx, info) {
    const cartItem = await ctx.db.query.cartItem(
      {
        where: {
          id: args.id
        }
      },
      `{ id, user {id}}`
    );
    if (!cartItem) throw new Error('No item found!');
    if (cartItem.user.id !== ctx.request.userId) {
      throw new Error('Uh');
    }
    return ctx.db.mutation.deleteCartItem(
      {
        where: {
          id: args.id
        }
      },
      info
    );
  },

  async createOrder(parent, args, ctx, info) {
    // 1. Query the current user and make sure they are signed in
    const { userId } = ctx.request;
    if (!userId)
      throw new Error('You must be signed in to complete the order.');
    const user = await ctx.db.query.user(
      { where: { id: userId } },
      `{
      id
      name
      email
      cart {
        id
        quantity
        item {
          title
          price
          id
          description
          image
          largeImage
        }
      }
    }`
    );
    // 2. Recalculate the total price
    const amount = user.cart.reduce(
      (acc, cartItem) => acc + cartItem.item.price * cartItem.quantity,
      0
    );
    // 3. Create the stripe charge (turn token into money)
    const charge = await stripe.charges.create({
      amount,
      currency: 'USD',
      source: args.token
    });
    // 4. Convert the cartItems to OrderItems
    const orderItems = user.cart.map(cartItem => {
      delete cartItem.category;
      delete cartItem.subcategory;
      const orderItem = {
        ...cartItem.item,
        quantity: cartItem.quantity,
        user: { connect: { id: userId } }
      };
      delete orderItem.id;
      return orderItem;
    });
    // 5. Create the Order
    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        items: { create: orderItems },
        user: { connect: { id: userId } }
      }
    });
    // 6. Clean the user`s cart && delete cartItems from db
    const cartItemIds = user.cart.map(cartItem => cartItem.id);
    await ctx.db.mutation.deleteManyCartItems({
      where: {
        id_in: cartItemIds
      }
    });
    // 8. Return the order to the client
    return order;
  },

  async updatePermissions(parent, args, ctx, info) {
    // 1. Check if user is logged in
    if (!ctx.request.userId) {
      throw new Error('You must be logged in!');
    }
    // 2. Query current user
    const currentUser = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId
        }
      },
      info
    );
    // 3. If admin
    const isAdmin = currentUser.permissions.includes('ADMIN');
    if (isAdmin) {
      return ctx.db.mutation.updateUser(
        {
          data: {
            permissions: {
              set: args.permissions
            }
          },
          where: {
            id: args.userId
          }
        },
        info
      );
    }
  }
};

module.exports = Mutation;
