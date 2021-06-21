function hasPermissions(user, permissionsNeeded) {
  const matchedPermissions = user.permissions.filter(userPermissions =>
    permissionsNeeded.includes(userPermissions)
  );
  if (!matchedPermissions.length) {
    throw new Error(
      `You do not have needed permissions : ${needed}. You have: ${
        user.permissions
      }`
    );
  }
}

exports.hasPermissions = hasPermissions;
